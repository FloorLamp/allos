// Auth-blind write core for confirming a condition SUGGESTION (issue #685) into a
// durable problem-list Condition. profileId-first, never imports lib/auth — the Server
// Action owns the gate + revalidation (#319). Mirrors promoteEpisodeToConditionCore:
// the insert is keyed by a deterministic external_id derived from the suggestion's
// CONCEPT (conditionCollapseKey), so a double-click / re-confirm is an idempotent
// no-op against the (profile_id, external_id) partial-unique index — never a duplicate
// row. Suggest-only (#560): this runs ONLY on an explicit user confirm, never on ingest.

import { db, writeTx } from "./db";
import { conditionCollapseKey } from "./icd10";
import { ICD10_SYSTEM, hasIcd10Code } from "./icd10";

export type AddSuggestedConditionOutcome =
  | { kind: "added"; conditionId: number }
  | { kind: "already"; conditionId: number }
  | { kind: "invalid" };

// The idempotency key for a confirmed suggestion — the concept's collapse key under a
// dedicated namespace, so re-confirming the same concept finds the row this created.
export function suggestedConditionExternalId(
  name: string,
  code: string | null
): string {
  return `condition-suggest:${conditionCollapseKey({ name, code })}`;
}

export function addSuggestedConditionCore(
  profileId: number,
  suggestion: { name: string; code: string | null }
): AddSuggestedConditionOutcome {
  const name = suggestion.name.trim();
  if (!name) return { kind: "invalid" };
  const code = suggestion.code?.trim() || null;
  const codeSystem = code && hasIcd10Code(code) ? ICD10_SYSTEM : null;
  const externalId = suggestedConditionExternalId(name, code);

  return writeTx(() => {
    const existing = db
      .prepare(
        `SELECT id FROM conditions WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, externalId) as { id: number } | undefined;
    if (existing) return { kind: "already" as const, conditionId: existing.id };

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO conditions
           (name, code, code_system, status, source, external_id, profile_id)
         VALUES (?, ?, ?, 'active', 'result', ?, ?)`
      )
      .run(name, code, codeSystem, externalId, profileId);
    // OR IGNORE could no-op under a race; re-read to return the authoritative id.
    if (info.changes === 0) {
      const row = db
        .prepare(
          `SELECT id FROM conditions WHERE profile_id = ? AND external_id = ?`
        )
        .get(profileId, externalId) as { id: number } | undefined;
      return row
        ? { kind: "already" as const, conditionId: row.id }
        : { kind: "invalid" as const };
    }
    return {
      kind: "added" as const,
      conditionId: Number(info.lastInsertRowid),
    };
  });
}
