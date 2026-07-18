// Auth-blind write core for promoting an illness episode to a Condition (issue #801)
// and undoing it. profileId-first, never imports lib/auth — the Server Action owns the
// gate + revalidation (#319). Closes the loop with #560's condition→situation bridge:
// an episode (derived from the illness situation) becomes a durable Condition with its
// onset/resolved taken from the derived [start, end) range.
//
// Row-op side-state (#202): the promotion is keyed by the episode's STABLE ROW id via
// episodeConditionExternalId, so boundary edits cannot detach it. Promote, edit, end,
// and merge all synchronize the episode-sourced condition's dates/status; undo removes
// exactly that row and never a hand-entered condition.

import { db, today, writeTx } from "./db";
import { shiftDateStr } from "./date";
import { episodeConditionExternalId } from "./illness-episode-format";
import { episodeReopenEligibility } from "./illness-episode-reopen";
import {
  getEpisodeRow,
  getOpenEpisodeRow,
  updateEpisodeBoundaries,
  type IllnessEpisodeRow,
} from "./illness-episode-store";
import { stopMedicationCourses } from "./queries/intake/medications";
import { getActiveSituations, setActiveSituations } from "./settings";
import { normalizeSituationName } from "./situations";

export type EpisodePromoteOutcome =
  | { kind: "promoted"; conditionId: number }
  | { kind: "already"; conditionId: number }
  | { kind: "invalid" };

function conditionValues(row: IllnessEpisodeRow) {
  return {
    externalId: episodeConditionExternalId(row.id),
    name: row.situation.trim(),
    status: row.ended_at ? "resolved" : "active",
    onsetDate: row.started_at,
    resolvedDate: row.ended_at ? shiftDateStr(row.ended_at, -1) : null,
  } as const;
}

// Keep an already-promoted condition aligned with its episode. Called inside the
// caller's writeTx; false simply means this episode has not been promoted.
function syncPromotedCondition(
  profileId: number,
  row: IllnessEpisodeRow
): boolean {
  const v = conditionValues(row);
  return (
    db
      .prepare(
        `UPDATE conditions
            SET name = ?, status = ?, onset_date = ?, resolved_date = ?
          WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
      )
      .run(
        v.name,
        v.status,
        v.onsetDate,
        v.resolvedDate,
        profileId,
        v.externalId
      ).changes > 0
  );
}

// Create (or find and synchronize) the Condition for an episode. onset = episode start;
// a closed episode (`end` set — the EXCLUSIVE first inactive day) resolves on end-1
// (the last active day) with status 'resolved'; an ongoing episode stays 'active' with
// no resolved date. The condition NAME is the situation (e.g. "Illness").
export function promoteEpisodeToConditionCore(
  profileId: number,
  episodeId: number
): EpisodePromoteOutcome {
  return writeTx(() => {
    const episode = getEpisodeRow(profileId, episodeId);
    if (!episode || !episode.situation.trim()) return { kind: "invalid" };
    const v = conditionValues(episode);
    const existing = db
      .prepare(
        `SELECT id FROM conditions WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, v.externalId) as { id: number } | undefined;
    if (existing) {
      syncPromotedCondition(profileId, episode);
      return { kind: "already" as const, conditionId: existing.id };
    }

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO conditions
           (name, status, onset_date, resolved_date, source, external_id, profile_id)
         VALUES (?, ?, ?, ?, 'episode', ?, ?)`
      )
      .run(
        v.name,
        v.status,
        v.onsetDate,
        v.resolvedDate,
        v.externalId,
        profileId
      );
    // OR IGNORE could no-op under a race; re-read to return the authoritative id.
    if (info.changes === 0) {
      const row = db
        .prepare(
          `SELECT id FROM conditions WHERE profile_id = ? AND external_id = ?`
        )
        .get(profileId, v.externalId) as { id: number } | undefined;
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
// illness_episodes row in the same writeTx (syncOpenIllnessEpisode). The toggle closes
// at today's boundary; this explicit "end episode" action then advances the exclusive
// end by one day so entries already logged today remain in its history. The row is still
// closed (`ended_at` is non-null), so current/open-episode state remains coherent.
// Idempotent: an already-closed episode is a no-op.
export function endEpisodeCore(
  profileId: number,
  episodeId: number
): EndEpisodeOutcome {
  return writeTx(() => {
    const row = getEpisodeRow(profileId, episodeId);
    if (!row) return { kind: "missing" };
    if (row.ended_at != null) {
      syncPromotedCondition(profileId, row);
      return { kind: "already" };
    }
    const target = normalizeSituationName(row.situation).toLowerCase();
    const next = getActiveSituations(profileId).filter(
      (s) => normalizeSituationName(s).toLowerCase() !== target
    );
    setActiveSituations(profileId, next);
    const transitionDay = today(profileId);
    const closedAtTransition = getEpisodeRow(profileId, episodeId);
    if (closedAtTransition?.ended_at === transitionDay) {
      updateEpisodeBoundaries(
        profileId,
        episodeId,
        closedAtTransition.started_at,
        shiftDateStr(transitionDay, 1)
      );
    }
    const closed = getEpisodeRow(profileId, episodeId);
    if (closed) syncPromotedCondition(profileId, closed);
    return { kind: "ended" };
  });
}

export type ReopenEpisodeOutcome =
  | { kind: "reopened" }
  | { kind: "already" }
  | { kind: "expired" }
  | { kind: "conflict" }
  | { kind: "missing" };

// Reopen a recently resolved episode when symptoms rebound. The row is reopened before
// the situation toggle runs, so syncOpenIllnessEpisode sees the stable existing row and
// does not create a second episode. The seven-day rule is checked inside the IMMEDIATE
// transaction as well as in the page UI; stale clients cannot reopen an old illness.
export function reopenEpisodeCore(
  profileId: number,
  episodeId: number
): ReopenEpisodeOutcome {
  return writeTx(() => {
    const row = getEpisodeRow(profileId, episodeId);
    if (!row) return { kind: "missing" };
    const eligibility = episodeReopenEligibility(
      row.ended_at,
      today(profileId)
    );
    if (eligibility.kind === "ongoing") return { kind: "already" };
    if (eligibility.kind !== "eligible") return { kind: "expired" };

    const open = getOpenEpisodeRow(profileId, row.situation);
    if (open && open.id !== row.id) return { kind: "conflict" };

    db.prepare(
      `UPDATE illness_episodes SET ended_at = NULL
        WHERE id = ? AND profile_id = ? AND ended_at IS NOT NULL`
    ).run(row.id, profileId);
    const active = getActiveSituations(profileId);
    if (
      !active.some(
        (name) =>
          normalizeSituationName(name).toLowerCase() ===
          normalizeSituationName(row.situation).toLowerCase()
      )
    ) {
      setActiveSituations(profileId, [...active, row.situation]);
    }
    const reopened = getEpisodeRow(profileId, row.id);
    if (reopened) syncPromotedCondition(profileId, reopened);
    return { kind: "reopened" };
  });
}

// Atomically edit boundaries + annotations and synchronize the promoted condition.
// One form submission is one IMMEDIATE transaction, so readers never observe a new
// range paired with an old note/outcome (or vice versa).
export function editEpisodeCore(
  profileId: number,
  episodeId: number,
  startedAt: string | null,
  endedAt: string | null,
  note: string | null,
  outcome: string | null
): boolean {
  return writeTx(() => {
    const changed =
      db
        .prepare(
          `UPDATE illness_episodes
              SET started_at = ?, ended_at = ?, note = ?, outcome = ?
            WHERE id = ? AND profile_id = ?`
        )
        .run(
          startedAt,
          endedAt,
          note?.trim() || null,
          outcome?.trim() || null,
          episodeId,
          profileId
        ).changes > 0;
    if (!changed) return false;
    const row = getEpisodeRow(profileId, episodeId);
    if (row) syncPromotedCondition(profileId, row);
    return true;
  });
}

// End an open episode BACKDATED to its last active day (issue #859 item 1, the stale
// nudge's one-tap close). Two steps, reusing the shipped #856 machinery — no new close
// path:
//   1. Deactivate the illness situation via the ONE toggle path (setActiveSituations),
//      which closes the open row through syncOpenIllnessEpisode and keeps
//      situations.active coherent ("never two truths").
//   2. Correct the row's exclusive end to `lastActiveDay` + 1 (the first inactive day)
//      with the plain row edit (updateEpisodeBoundaries), so the closed episode reads
//      as having ended when it actually went quiet, not today.
// Derived membership follows the new [start, end) automatically. Idempotent: an
// already-closed episode is a no-op; a missing one reports missing.
export function endEpisodeAsOfCore(
  profileId: number,
  episodeId: number,
  lastActiveDay: string
): EndEpisodeOutcome {
  const row = getEpisodeRow(profileId, episodeId);
  if (!row) return { kind: "missing" };
  if (row.ended_at != null) return { kind: "already" };
  const target = normalizeSituationName(row.situation).toLowerCase();
  const next = getActiveSituations(profileId).filter(
    (s) => normalizeSituationName(s).toLowerCase() !== target
  );
  setActiveSituations(profileId, next);
  // Exclusive end = the first inactive day = last active day + 1.
  updateEpisodeBoundaries(
    profileId,
    episodeId,
    row.started_at,
    shiftDateStr(lastActiveDay, 1)
  );
  const closed = getEpisodeRow(profileId, episodeId);
  if (closed) syncPromotedCondition(profileId, closed);
  return { kind: "ended" };
}

export interface EndEpisodeWithMedsOutcome {
  kind: "ended" | "already" | "missing";
  stoppedItemIds: number[];
}

// End an episode AND close the courses of the selected episode-associated meds in ONE
// atomic writeTx (issue #880). SUGGEST-ONLY (#560): the CALLER (the Server Action) has
// already intersected `medItemIds` with the derived associated set
// (getEpisodeMedReconciliation), so a forged id can't close an unrelated chronic med;
// stopMedicationCourses independently re-verifies ownership+kind. `lastActiveDay` routes
// the backdated stale-nudge end (endEpisodeAsOfCore, #859); absent → the "feeling better"
// end (endEpisodeCore). Selected courses close with the new `illness_resolved` reason as
// of the episode's end day, so the med's history reads "used during: <this illness>".
// Nested writeTx is a SAVEPOINT (#468), so the episode close and every course close commit
// or roll back together. An empty `medItemIds` just ends the episode (the no-meds path).
export function endEpisodeWithMedReconciliation(
  profileId: number,
  episodeId: number,
  medItemIds: number[],
  lastActiveDay?: string | null
): EndEpisodeWithMedsOutcome {
  return writeTx(() => {
    const row = getEpisodeRow(profileId, episodeId);
    if (!row) return { kind: "missing", stoppedItemIds: [] };
    if (row.ended_at != null) return { kind: "already", stoppedItemIds: [] };
    const ended = lastActiveDay
      ? endEpisodeAsOfCore(profileId, episodeId, lastActiveDay)
      : endEpisodeCore(profileId, episodeId);
    if (ended.kind !== "ended") return { kind: ended.kind, stoppedItemIds: [] };
    // Close the selected courses as of the episode's end day (the last active day for a
    // backdated end, else today — the day it stopped being taken for the illness).
    const stopDate = lastActiveDay ?? today(profileId);
    const stopped: number[] = [];
    for (const itemId of medItemIds) {
      stopMedicationCourses(profileId, itemId, {
        date: stopDate,
        reason: "illness_resolved",
      });
      stopped.push(itemId);
    }
    return { kind: "ended", stoppedItemIds: stopped };
  });
}

// Undo a promotion: delete ONLY the episode-sourced condition this created (matched by
// its deterministic external_id AND source='episode'), never a manually-entered row.
// Returns true when a row was removed.
export function unpromoteEpisodeConditionCore(
  profileId: number,
  episodeId: number
): boolean {
  const externalId = episodeConditionExternalId(episodeId);
  const res = db
    .prepare(
      `DELETE FROM conditions
        WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
    )
    .run(profileId, externalId);
  return res.changes > 0;
}
