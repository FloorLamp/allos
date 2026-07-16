// Auth-blind write core for promoting an illness episode to a Condition (issue #801)
// and undoing it. profileId-first, never imports lib/auth — the Server Action owns the
// gate + revalidation (#319). Closes the loop with #560's condition→situation bridge:
// an episode (derived from the illness situation) becomes a durable Condition with its
// onset/resolved taken from the derived [start, end) range.
//
// Row-op side-state (#202): the promotion is keyed by a deterministic external_id
// (episodeConditionExternalId), so a re-promote is an idempotent no-op and the undo can
// find + remove exactly the row this created — never a hand-entered condition. The
// insert uses OR IGNORE against the (profile_id, external_id) partial-unique index, the
// same idempotent-promotion pattern as promoteMedicationSideEffect.

import { db, writeTx } from "./db";
import { shiftDateStr } from "./date";
import { episodeConditionExternalId } from "./illness-episode-format";
import { getEpisodeRow } from "./illness-episode-store";
import { getActiveSituations, setActiveSituations } from "./settings";
import { normalizeSituationName } from "./situations";

export type EpisodePromoteOutcome =
  | { kind: "promoted"; conditionId: number }
  | { kind: "already"; conditionId: number }
  | { kind: "invalid" };

// Create (or find the existing) Condition for an episode. onset = the episode start;
// a closed episode (`end` set — the EXCLUSIVE first inactive day) resolves on end-1
// (the last active day) with status 'resolved'; an ongoing episode stays 'active' with
// no resolved date. The condition NAME is the situation (e.g. "Illness").
export function promoteEpisodeToConditionCore(
  profileId: number,
  situation: string,
  start: string | null,
  end: string | null
): EpisodePromoteOutcome {
  const name = situation.trim();
  if (!name) return { kind: "invalid" };
  const externalId = episodeConditionExternalId(situation, start);
  const resolvedDate = end ? shiftDateStr(end, -1) : null;
  const status = end ? "resolved" : "active";

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
           (name, status, onset_date, resolved_date, source, external_id, profile_id)
         VALUES (?, ?, ?, ?, 'episode', ?, ?)`
      )
      .run(name, status, start, resolvedDate, externalId, profileId);
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
      kind: "promoted" as const,
      conditionId: Number(info.lastInsertRowid),
    };
  });
}

export type EndEpisodeOutcome =
  { kind: "ended" } | { kind: "already" } | { kind: "missing" };

// End an open episode from the page ("Feeling better", #856 item 2). Ending an episode
// IS deactivating its illness situation — so this routes through the ONE toggle write
// path (setActiveSituations), which both flips situations.active AND closes the open
// illness_episodes row in the same writeTx (syncOpenIllnessEpisode). Never a second
// close path — single source of truth. Idempotent: an already-closed episode is a no-op.
export function endEpisodeCore(
  profileId: number,
  episodeId: number
): EndEpisodeOutcome {
  const row = getEpisodeRow(profileId, episodeId);
  if (!row) return { kind: "missing" };
  if (row.ended_at != null) return { kind: "already" };
  const target = normalizeSituationName(row.situation).toLowerCase();
  const next = getActiveSituations(profileId).filter(
    (s) => normalizeSituationName(s).toLowerCase() !== target
  );
  setActiveSituations(profileId, next);
  return { kind: "ended" };
}

// Undo a promotion: delete ONLY the episode-sourced condition this created (matched by
// its deterministic external_id AND source='episode'), never a manually-entered row.
// Returns true when a row was removed.
export function unpromoteEpisodeConditionCore(
  profileId: number,
  situation: string,
  start: string | null
): boolean {
  const externalId = episodeConditionExternalId(situation, start);
  const res = db
    .prepare(
      `DELETE FROM conditions
        WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
    )
    .run(profileId, externalId);
  return res.changes > 0;
}
