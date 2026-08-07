// The stored illness-episode identity layer (issue #856). An illness episode now has a
// STABLE ROW (lib/migrations/versions/046) carrying identity + user annotations (note,
// outcome) and user-editable boundaries — but MEMBERSHIP stays DERIVED: symptoms,
// temperatures, administrations, and in-range clinical events carry NO FK to an episode,
// so a boundary edit or retro-create is automatically correct with nothing re-parented.
//
// This module is the auth-blind (profileId-first, never imports lib/auth — #319) DB
// read/write for those rows. Every statement is profile-scoped. `start_date`/`end_date`
// (#2232, migration 169 — day-window vocabulary, both bounds INCLUSIVE) carry the SAME
// semantics as the derived IllnessEpisode (lib/symptom-episode.ts):
//   start_date = inclusive first active day (YYYY-MM-DD; NULL = active before the log)
//   end_date   = inclusive LAST active day (NULL = open/ongoing)
// keeping them identical is what keeps assembleIllnessEpisode's window one value with
// no per-boundary conversion.
//
// The flagged-situation toggle opens/closes rows through syncOpenIllnessEpisode, called
// INSIDE the same writeTx that flips situations.active (lib/settings/profile-attrs.ts),
// so the active-situation set and the open row never disagree ("never two truths").

import { db, today, writeTx } from "./db";
import { shiftDateStr } from "./date";
import { rangeContainsDate } from "./date-range";
import { episodeConditionExternalId } from "./illness-episode-format";
import { episodeReopenEligibility } from "./illness-episode-reopen";
import {
  clearEpisodeVisitLinks,
  reparentEpisodeVisitLinks,
} from "./queries/visit-links";
import { normalizeSituationName } from "./situations";
import type { IllnessEpisode } from "./symptom-episode";

export interface IllnessEpisodeRow {
  id: number;
  profile_id: number;
  situation: string;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  outcome: string | null;
}

const COLS = "id, profile_id, situation, start_date, end_date, note, outcome";

// Map a stored row to the derived-episode shape assembleIllnessEpisode consumes. The
// `id` rides along so surfaces can link to /medical/episodes/[id]; the derivations in
// symptom-episode.ts leave it undefined (they never had a row).
export function episodeRowToDerived(row: IllnessEpisodeRow): IllnessEpisode {
  return {
    id: row.id,
    situation: row.situation,
    start: row.start_date,
    end: row.end_date,
  };
}

// One episode row by id, scoped to the profile (the [id] route + share resolver).
export function getEpisodeRow(
  profileId: number,
  id: number
): IllnessEpisodeRow | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM illness_episodes WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as IllnessEpisodeRow | undefined) ?? null
  );
}

// Resolve an episode by id across a SET of profile ids — the viewer's ACCESSIBLE set
// (issue #879). Returns the owning profile id + row, or null when no accessible profile
// owns it. This is how the [id] page reads a household member's episode WITHOUT
// switching the acting profile: it tries each accessible profile's scoped getEpisodeRow,
// so every query stays profile-scoped (no unscoped illness_episodes read) and the grants
// boundary is untouched — an UNGRANTED profile is simply absent from `profileIds`, so its
// episode 404s, exactly like guessing another profile's id under the old active-only
// scope. Auth-blind (takes ids, never imports lib/auth); the page supplies the set.
export function resolveEpisodeAcrossProfiles(
  profileIds: number[],
  id: number
): { profileId: number; row: IllnessEpisodeRow } | null {
  for (const pid of profileIds) {
    const row = getEpisodeRow(pid, id);
    if (row) return { profileId: pid, row };
  }
  return null;
}

// The episode row CONTAINING `date`, tightest (most-recently-started) first — the row
// analogue of the old episodeForDate derivation. A row covers `date` when its inclusive
// start is on-or-before it (null start = since before the log) and its inclusive end is
// on-or-after it (null end = ongoing). The WHERE clause below is the SQL REALIZATION
// of the chassis's inclusive-end predicate (rangeContainsDate, lib/date-range.ts) — SQL
// can't call the JS matcher, so the two are kept in step by hand (the #394 finite-preimage
// precedent).
export function getEpisodeRowForDate(
  profileId: number,
  date: string
): IllnessEpisodeRow | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM illness_episodes
          WHERE profile_id = ?
            AND (start_date IS NULL OR start_date <= ?)
            AND (end_date IS NULL OR end_date >= ?)
          ORDER BY start_date IS NULL, start_date DESC, id DESC
          LIMIT 1`
      )
      .get(profileId, date, date) as IllnessEpisodeRow | undefined) ?? null
  );
}

// The id of the OPEN illness episode that COVERS `date` (start_date ≤ date, end_date
// NULL), or null. The default-association source when a symptom is logged (#1093): a
// symptom logged while an episode is open rolls up under it. Only OPEN episodes qualify
// — a backfilled/closed episode never retro-claims a freshly logged symptom (that would
// re-attach on any past-date edit). Profile-scoped.
export function openEpisodeIdForDate(
  profileId: number,
  date: string
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM illness_episodes
        WHERE profile_id = ?
          AND (start_date IS NULL OR start_date <= ?)
          AND end_date IS NULL
        ORDER BY start_date IS NULL, start_date DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, date) as { id: number } | undefined;
  return row?.id ?? null;
}

// True when `episodeId` is an illness episode owned by `profileId` — the ownership gate
// the symptom-episode attach uses so a forged cross-profile id is rejected at the data
// layer (belt-and-suspenders to the action's write-access gate). Profile-scoped.
export function episodeExistsForProfile(
  profileId: number,
  episodeId: number
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM illness_episodes WHERE id = ? AND profile_id = ?`)
      .get(episodeId, profileId) != null
  );
}

// The current OPEN row of a named situation (end_date IS NULL), or null. NOCASE-matched
// on the situation name so casing/whitespace variants resolve to the same episode.
export function getOpenEpisodeRow(
  profileId: number,
  situation: string
): IllnessEpisodeRow | null {
  const norm = normalizeSituationName(situation);
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM illness_episodes
          WHERE profile_id = ? AND situation = ? COLLATE NOCASE AND end_date IS NULL
          ORDER BY start_date IS NULL, start_date DESC, id DESC
          LIMIT 1`
      )
      .get(profileId, norm) as IllnessEpisodeRow | undefined) ?? null
  );
}

// The profile's most-recently CLOSED episode row (end_date set), by last-active-day
// descending — the ease-back ramp's anchor (issue #837). Null when no closed episode
// exists. Every row here is a flagged-illness episode (syncOpenIllnessEpisode only
// opens rows for illness-type situations), so no extra filtering is needed.
export function mostRecentClosedEpisodeRow(
  profileId: number
): IllnessEpisodeRow | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM illness_episodes
          WHERE profile_id = ? AND end_date IS NOT NULL
          ORDER BY end_date DESC, id DESC
          LIMIT 1`
      )
      .get(profileId) as IllnessEpisodeRow | undefined) ?? null
  );
}

// The profile's most-recently resolved episode that is STILL within its 7-day reopen
// window (#1140 Part A) — the dashboard "Recently resolved — reopen?" affordance's
// subject. Uses the SAME episodeReopenEligibility rule as the detail page (one
// computation, #221). Returns null when there's no closed episode, it has expired, or the
// same situation is currently OPEN again (that's a hero cockpit, not a reopen prompt).
export interface ReopenEligibleEpisode {
  id: number;
  situation: string;
  // The inclusive last active day (the stored end_date).
  endDate: string;
}

export function reopenEligibleEpisodeForProfile(
  profileId: number
): ReopenEligibleEpisode | null {
  const row = mostRecentClosedEpisodeRow(profileId);
  if (!row || !row.end_date) return null;
  if (
    episodeReopenEligibility(row.end_date, today(profileId)).kind !== "eligible"
  )
    return null;
  if (getOpenEpisodeRow(profileId, row.situation)) return null;
  return { id: row.id, situation: row.situation, endDate: row.end_date };
}

// The count of DISTINCT days within [start, end] (inclusive) that fell inside a
// flagged-illness episode — the weekly recap's "sick N days this week" honesty line
// (issue #837), so a sick week reads as a sick week, not a failed one. Loads the
// episodes overlapping the window (inclusive bounds: start_date ≤ end, end_date ≥
// start or open) and counts the covered days in JS (the window is ≤ ~31 days, and
// overlapping episodes are de-duplicated by the day set). The per-day membership routes
// through the chassis's inclusive-end predicate (rangeContainsDate, lib/date-range.ts).
export function illnessDaysInWindow(
  profileId: number,
  start: string,
  end: string
): number {
  const rows = db
    .prepare(
      `SELECT start_date, end_date FROM illness_episodes
        WHERE profile_id = ?
          AND (start_date IS NULL OR start_date <= ?)
          AND (end_date IS NULL OR end_date >= ?)`
    )
    .all(profileId, end, start) as {
    start_date: string | null;
    end_date: string | null;
  }[];
  if (rows.length === 0) return 0;
  let covered = 0;
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) {
    const inEpisode = rows.some((r) =>
      rangeContainsDate({ start: r.start_date, end: r.end_date }, d)
    );
    if (inEpisode) covered++;
  }
  return covered;
}

// All of a profile's episode rows, most-recent first (a known start outranks a
// before-log null start). Backs allEpisodesForProfile + the episodes index (#856 item 9).
export function listEpisodeRows(profileId: number): IllnessEpisodeRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM illness_episodes
        WHERE profile_id = ?
        ORDER BY start_date IS NULL, start_date DESC, id DESC`
    )
    .all(profileId) as IllnessEpisodeRow[];
}

// Open/close the single open row of an illness situation to match its active state,
// keyed on `onDate` (the profile-local transition day the toggle logs). Idempotent:
// opening when a row is already open is a no-op; closing when none is open is a no-op.
// Composes inside a CALLER'S writeTx (the situation toggle) — never opens its own.
export function syncOpenIllnessEpisode(
  profileId: number,
  situation: string,
  shouldBeOpen: boolean,
  onDate: string
): void {
  const norm = normalizeSituationName(situation);
  if (!norm) return;
  const open = getOpenEpisodeRow(profileId, norm);
  if (shouldBeOpen) {
    if (open) return;
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
       VALUES (?, ?, ?, NULL)`
    ).run(profileId, norm, onDate);
  } else {
    if (!open) return;
    // The toggle's stop day (`onDate`) is the first INACTIVE day — diffSituations'
    // stop event — so the inclusive end_date is the day before it (#2232). A same-day
    // open-then-close leaves end_date = start_date − 1: an empty window, covering no
    // days, exactly as the old [start, start) did.
    db.prepare(
      `UPDATE illness_episodes SET end_date = ?
        WHERE id = ? AND profile_id = ? AND end_date IS NULL`
    ).run(shiftDateStr(onDate, -1), open.id, profileId);
  }
}

// Retro-create a closed (or open) episode row directly — the item-1 "was sick last
// week, never toggled" path. Opens its own writeTx.
export function createEpisodeRow(
  profileId: number,
  situation: string,
  startDate: string | null,
  endDate: string | null,
  note: string | null = null,
  outcome: string | null = null
): number {
  const norm = normalizeSituationName(situation) || situation.trim();
  return writeTx(() =>
    Number(
      db
        .prepare(
          `INSERT INTO illness_episodes
             (profile_id, situation, start_date, end_date, note, outcome)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(profileId, norm, startDate, endDate, note, outcome).lastInsertRowid
    )
  );
}

// Correct an episode's boundaries in place. Used by the stale-episode backdated close;
// the richer form edit lives in editEpisodeCore so it can synchronize its Condition.
export function updateEpisodeBoundaries(
  profileId: number,
  id: number,
  startDate: string | null,
  endDate: string | null
): boolean {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE illness_episodes SET start_date = ?, end_date = ?
            WHERE id = ? AND profile_id = ?`
        )
        .run(startDate, endDate, id, profileId).changes > 0
  );
}

// Delete an episode row (the "loser" of a flap-merge, item 1). Row-op side-state
// (#199/#202): any share link that re-anchored to this id has its episode_id NULLED
// first (the anchor-date fallback then resolves it), so the FK never throws. Opens its
// own writeTx.
export function deleteEpisodeRow(profileId: number, id: number): boolean {
  return writeTx(() => {
    db.prepare(
      `UPDATE profile_share_links SET episode_id = NULL
        WHERE episode_id = ? AND profile_id = ?`
    ).run(id, profileId);
    // Row-op side-state (#203/#1198): clear this episode's visit links + agreed 'linked'
    // decisions, and its stopped-med reversal records (#1140 Part B), before dropping the
    // row (their FKs to illness_episodes carry no ON DELETE).
    clearEpisodeVisitLinks(profileId, id);
    // #1093 row-side-state: symptoms OUTLIVE the grouping — null their back-link before
    // dropping the episode (foreign_keys=ON would otherwise reject the delete). The
    // symptom-days themselves (and their photos) stay.
    db.prepare(
      `UPDATE symptom_logs SET episode_id = NULL
        WHERE episode_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare(
      `DELETE FROM episode_stopped_meds WHERE episode_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare(
      `DELETE FROM conditions
        WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
    ).run(profileId, episodeConditionExternalId(id));
    return (
      db
        .prepare(`DELETE FROM illness_episodes WHERE id = ? AND profile_id = ?`)
        .run(id, profileId).changes > 0
    );
  });
}

// Merge two episode rows into one (flap-split repair, item 1): widen the KEEPER to the
// union of both ranges (earliest known start, latest end — a null end means one is still
// open so the merged episode is open) and delete the loser. Both must be the same
// profile's; the keeper's note/outcome win. Returns the keeper id, or null on a bad ref.
export function mergeEpisodeRows(
  profileId: number,
  keepId: number,
  dropId: number
): number | null {
  if (keepId === dropId) return keepId;
  return writeTx(() => {
    const keep = getEpisodeRow(profileId, keepId);
    const drop = getEpisodeRow(profileId, dropId);
    if (!keep || !drop) return null;
    // Union start: a null (before-log) start floors everything; else the earlier date.
    const start =
      keep.start_date == null || drop.start_date == null
        ? null
        : keep.start_date < drop.start_date
          ? keep.start_date
          : drop.start_date;
    // Union end: a null (open) end means the union is still open; else the later date.
    const end =
      keep.end_date == null || drop.end_date == null
        ? null
        : keep.end_date > drop.end_date
          ? keep.end_date
          : drop.end_date;

    // Stable row-op side-state: preserve one promotion across the merge. Prefer the
    // keeper's condition; otherwise re-anchor the loser's condition to the keeper id.
    // If both were promoted, the loser's generated condition is redundant and removed.
    const keepExternal = episodeConditionExternalId(keepId);
    const dropExternal = episodeConditionExternalId(dropId);
    const keepCondition = db
      .prepare(
        `SELECT id FROM conditions
          WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
      )
      .get(profileId, keepExternal) as { id: number } | undefined;
    const dropCondition = db
      .prepare(
        `SELECT id FROM conditions
          WHERE profile_id = ? AND external_id = ? AND source = 'episode'`
      )
      .get(profileId, dropExternal) as { id: number } | undefined;
    if (dropCondition && keepCondition) {
      db.prepare(
        `DELETE FROM conditions
          WHERE id = ? AND profile_id = ? AND source = 'episode'`
      ).run(dropCondition.id, profileId);
    } else if (dropCondition) {
      db.prepare(
        `UPDATE conditions SET external_id = ?
          WHERE id = ? AND profile_id = ? AND source = 'episode'`
      ).run(keepExternal, dropCondition.id, profileId);
    }

    db.prepare(
      `UPDATE illness_episodes SET start_date = ?, end_date = ?
        WHERE id = ? AND profile_id = ?`
    ).run(start, end, keepId, profileId);
    // Value-sync of the surviving promoted condition — the merge-shaped sibling of
    // syncPromotedCondition, under the SAME #2137 edit lock: a hand-edited row is a
    // full hold-out (`AND edited = 0`), receiving nothing from the merge. The
    // re-anchor above is deliberately NOT gated: repointing external_id is identity
    // maintenance that keeps a (possibly edited) row attached to the surviving
    // episode; the lock protects the row's VALUES, not its linkage.
    db.prepare(
      `UPDATE conditions
          SET name = ?, status = ?, onset_date = ?, resolved_date = ?
        WHERE profile_id = ? AND external_id = ? AND source = 'episode'
          AND edited = 0`
    ).run(
      keep.situation,
      end ? "resolved" : "active",
      start,
      // The inclusive end IS the last active day (#2232) — no off-by-one to compensate.
      end,
      profileId,
      keepExternal
    );
    db.prepare(
      `UPDATE profile_share_links SET episode_id = ?
        WHERE episode_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    // Row-op side-state (#199/#1198): move the loser's visit links + 'linked' decisions
    // onto the keeper (de-duping), and re-parent its stopped-med reversal records
    // (#1140 Part B), before the loser row is dropped.
    reparentEpisodeVisitLinks(profileId, keepId, dropId);
    // #1093 row-side-state: re-parent the loser's symptoms onto the keeper (the same
    // children-move-to-keeper treatment as visit-links + stopped-meds), so the merged
    // episode's reverse query still gathers them and foreign_keys=ON meets a clean graph
    // when the loser row is dropped.
    db.prepare(
      `UPDATE symptom_logs SET episode_id = ?
        WHERE episode_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    db.prepare(
      `UPDATE OR IGNORE episode_stopped_meds SET episode_id = ?
        WHERE episode_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    db.prepare(
      `DELETE FROM episode_stopped_meds WHERE episode_id = ? AND profile_id = ?`
    ).run(dropId, profileId);
    db.prepare(
      `DELETE FROM illness_episodes WHERE id = ? AND profile_id = ?`
    ).run(dropId, profileId);
    return keepId;
  });
}
