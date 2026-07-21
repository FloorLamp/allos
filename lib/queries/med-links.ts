import { db, writeTx } from "../db";
import {
  suggestIndicationFromText,
  type ConditionRef,
} from "../indication-link";
import {
  classifyPrescriberLink,
  type PrescriberLinkClass,
  type RegistryProviderRow,
} from "../prescriber-link";

// The DB read/derive + decision-persistence layer for the two medication links
// (#1051 med↔prescriber, #1052 med↔indication). The suggestion MATH is pure
// (lib/prescriber-link.ts, lib/indication-link.ts); this module gathers rows, derives
// suggestions at READ time (nothing stored but the accept/decline decision in
// med_link_decisions), and applies an accepted link by setting the med's FK. Every
// statement is profile-scoped; the write cores are auth-blind (the actions gate).

// A medication's stable identity token. Meds carry NO external_id (they dedup on
// document_id + source), so the token is always id-based — a manual med's id is
// stable; an imported med re-derives its structural link on reprocess (tier-1), so a
// churned imported-med id at most re-offers the tier-2 suggestion (never a wrong link).
export function medToken(id: number): string {
  return `id:${id}`;
}
function targetToken(id: number): string {
  return `id:${id}`;
}

type MedLinkKind = "prescriber" | "indication";

function declinedTargetKeys(
  profileId: number,
  kind: MedLinkKind,
  medId: number
): Set<string> {
  const rows = db
    .prepare(
      `SELECT target_key FROM med_link_decisions
        WHERE profile_id = ? AND kind = ? AND subject_key = ? AND decision = 'declined'`
    )
    .all(profileId, kind, medToken(medId)) as { target_key: string }[];
  return new Set(rows.map((r) => r.target_key));
}

function upsertDecision(
  profileId: number,
  kind: MedLinkKind,
  medId: number,
  targetId: number,
  decision: "linked" | "declined"
): void {
  db.prepare(
    `INSERT INTO med_link_decisions
       (profile_id, kind, subject_key, target_key, decision)
     VALUES (?,?,?,?,?)
     ON CONFLICT(profile_id, kind, subject_key, target_key)
       DO UPDATE SET decision = excluded.decision, created_at = datetime('now')`
  ).run(profileId, kind, medToken(medId), targetToken(targetId), decision);
}

// Confirm a medication id belongs to the profile (kind guard). Returns its id or null.
function ownedMed(profileId: number, medId: number): number | null {
  const row = db
    .prepare(
      "SELECT id FROM intake_items WHERE id = ? AND profile_id = ? AND kind = 'medication'"
    )
    .get(medId, profileId) as { id: number } | undefined;
  return row ? row.id : null;
}

// ── #1052 med → indication ────────────────────────────────────────────────────────

// The medications treating a condition ("Treated with: …"), for the condition surface.
// Scoped by profile_id; only structured meds.
export function getMedicationsForCondition(
  profileId: number,
  conditionId: number
): { id: number; name: string; active: number }[] {
  return db
    .prepare(
      `SELECT id, name, active FROM intake_items
        WHERE profile_id = ? AND kind = 'medication'
          AND indication_condition_id = ?
        ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all(profileId, conditionId) as {
    id: number;
    name: string;
    active: number;
  }[];
}

// A map conditionId → treating medication names, for the /records conditions list
// "Treated with:" sub-line (one query, not N+1). Only structured, indication-linked
// meds; empty map when none.
export function getMedicationsByIndication(
  profileId: number
): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT indication_condition_id AS cid, name, active
         FROM intake_items
        WHERE profile_id = ? AND kind = 'medication'
          AND indication_condition_id IS NOT NULL
        ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all(profileId) as { cid: number; name: string; active: number }[];
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const arr = out.get(r.cid) ?? [];
    arr.push(r.name);
    out.set(r.cid, arr);
  }
  return out;
}

// The profile's recorded conditions as the pure matcher's ConditionRef shape.
function conditionRefs(profileId: number): ConditionRef[] {
  return db
    .prepare(`SELECT id, name, code FROM conditions WHERE profile_id = ?`)
    .all(profileId) as ConditionRef[];
}

// The indication text a med carries for tier-2 matching: its own free-text notes plus
// its courses' notes / stop reasons (where the imported reasonCode "why prescribed"
// note lands). Deduped, non-empty pieces joined.
function medIndicationText(profileId: number, medId: number): string {
  const med = db
    .prepare("SELECT notes FROM intake_items WHERE id = ? AND profile_id = ?")
    .get(medId, profileId) as { notes: string | null } | undefined;
  const courseNotes = db
    .prepare(
      `SELECT c.notes AS notes, c.stop_reason AS stop_reason
         FROM medication_courses c
         JOIN intake_items ii ON ii.id = c.item_id
        WHERE ii.id = ? AND ii.profile_id = ?`
    )
    .all(medId, profileId) as {
    notes: string | null;
    stop_reason: string | null;
  }[];
  const pieces = [
    med?.notes,
    ...courseNotes.flatMap((c) => [c.notes, c.stop_reason]),
  ].filter((s): s is string => !!s && s.trim().length > 0);
  return [...new Set(pieces)].join(" · ");
}

// Tier-2 read-time indication suggestion for ONE unlinked medication (#1052): the
// condition its imported/entered indication TEXT exactly names, minus any pair the
// user already declined. Null when the med is already linked, missing, or nothing
// matches. Proposes, never links — the accept action persists.
export function indicationSuggestionForMed(
  profileId: number,
  medId: number
): ConditionRef | null {
  const row = db
    .prepare(
      `SELECT indication_condition_id AS cid FROM intake_items
        WHERE id = ? AND profile_id = ? AND kind = 'medication'`
    )
    .get(medId, profileId) as { cid: number | null } | undefined;
  if (!row || row.cid != null) return null;
  const text = medIndicationText(profileId, medId);
  if (!text) return null;
  const suggestion = suggestIndicationFromText(text, conditionRefs(profileId));
  if (!suggestion) return null;
  if (
    declinedTargetKeys(profileId, "indication", medId).has(
      targetToken(suggestion.id)
    )
  )
    return null;
  return suggestion;
}

// Accept an indication link (tier-2 or manual): set indication_condition_id AND record
// a durable 'linked' decision. Verifies both rows belong to the profile. Returns true
// when the link was set.
export function linkMedIndication(
  profileId: number,
  medId: number,
  conditionId: number
): boolean {
  return writeTx(() => {
    if (ownedMed(profileId, medId) == null) return false;
    const cond = db
      .prepare("SELECT id FROM conditions WHERE id = ? AND profile_id = ?")
      .get(conditionId, profileId) as { id: number } | undefined;
    if (!cond) return false;
    db.prepare(
      `UPDATE intake_items SET indication_condition_id = ?
        WHERE id = ? AND profile_id = ?`
    ).run(conditionId, medId, profileId);
    upsertDecision(profileId, "indication", medId, conditionId, "linked");
    return true;
  });
}

// Decline a suggested indication pair: remembered so it's never re-suggested.
export function declineMedIndication(
  profileId: number,
  medId: number,
  conditionId: number
): boolean {
  return writeTx(() => {
    if (ownedMed(profileId, medId) == null) return false;
    upsertDecision(profileId, "indication", medId, conditionId, "declined");
    return true;
  });
}

// ── #1051 med → prescriber ──────────────────────────────────────────────────────────

// Registry rows sharing OR near a name (case-insensitive) — the candidate set the
// pure prescriber classifier needs (exact same-name AND near-miss surnames). The
// registry is small + global, so fetch the whole table and let the pure engine decide.
function registryRows(): RegistryProviderRow[] {
  return db
    .prepare("SELECT id, type, name, npi FROM providers")
    .all() as RegistryProviderRow[];
}

// A per-med prescriber suggestion (#1051 historical / suggest-and-accept): a med with a
// free-text prescriber, NO provider_id link, whose name near-misses an individual or
// exactly matches an org-only row. `cls` carries the proposed provider + which case.
export interface PrescriberSuggestion {
  medId: number;
  medName: string;
  prescriber: string;
  cls: Extract<PrescriberLinkClass, { kind: "near-miss" | "org-mistype" }>;
}

export function prescriberSuggestionsForProfile(
  profileId: number
): PrescriberSuggestion[] {
  const meds = db
    .prepare(
      `SELECT id, name, prescriber FROM intake_items
        WHERE profile_id = ? AND kind = 'medication'
          AND provider_id IS NULL
          AND prescriber IS NOT NULL AND TRIM(prescriber) <> ''`
    )
    .all(profileId) as { id: number; name: string; prescriber: string }[];
  if (meds.length === 0) return [];
  const rows = registryRows();
  const out: PrescriberSuggestion[] = [];
  const declinedByMed = new Map<number, Set<string>>();
  for (const m of meds) {
    const cls = classifyPrescriberLink(m.prescriber, rows);
    if (cls.kind !== "near-miss" && cls.kind !== "org-mistype") continue;
    let declined = declinedByMed.get(m.id);
    if (!declined) {
      declined = declinedTargetKeys(profileId, "prescriber", m.id);
      declinedByMed.set(m.id, declined);
    }
    if (declined.has(targetToken(cls.providerId))) continue;
    out.push({
      medId: m.id,
      medName: m.name,
      prescriber: m.prescriber,
      cls,
    });
  }
  return out;
}

// The COUNT of meds with a pending prescriber-link suggestion (#1045 data-quality gap).
export function countPrescribersNeedingLink(profileId: number): number {
  return prescriberSuggestionsForProfile(profileId).length;
}

// Accept a prescriber link (#1051 near-miss / manual): set provider_id to the (already
// individual) registry row AND record a 'linked' decision. Verifies the med belongs to
// the profile and the provider is an INDIVIDUAL (semantics decision (a) — never an org).
// Returns true when the link was set.
export function linkMedPrescriber(
  profileId: number,
  medId: number,
  providerId: number
): boolean {
  return writeTx(() => {
    if (ownedMed(profileId, medId) == null) return false;
    const prov = db
      .prepare("SELECT id, type FROM providers WHERE id = ?")
      .get(providerId) as { id: number; type: string } | undefined;
    if (!prov || prov.type !== "individual") return false;
    db.prepare(
      `UPDATE intake_items SET provider_id = ? WHERE id = ? AND profile_id = ?`
    ).run(providerId, medId, profileId);
    upsertDecision(profileId, "prescriber", medId, providerId, "linked");
    return true;
  });
}

// Decline a suggested prescriber pair: remembered so the gap detector stops proposing it.
export function declineMedPrescriber(
  profileId: number,
  medId: number,
  providerId: number
): boolean {
  return writeTx(() => {
    if (ownedMed(profileId, medId) == null) return false;
    upsertDecision(profileId, "prescriber", medId, providerId, "declined");
    return true;
  });
}
