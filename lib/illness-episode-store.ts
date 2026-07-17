// The stored illness-episode identity layer (issue #856). An illness episode now has a
// STABLE ROW (lib/migrations/versions/046) carrying identity + user annotations (note,
// outcome) and user-editable boundaries — but MEMBERSHIP stays DERIVED: symptoms,
// temperatures, administrations, and in-range clinical events carry NO FK to an episode,
// so a boundary edit or retro-create is automatically correct with nothing re-parented.
//
// This module is the auth-blind (profileId-first, never imports lib/auth — #319) DB
// read/write for those rows. Every statement is profile-scoped. `started_at`/`ended_at`
// carry the SAME semantics as the derived IllnessEpisode (lib/symptom-episode.ts):
//   started_at = inclusive first active day (YYYY-MM-DD; NULL = active before the log)
//   ended_at   = EXCLUSIVE end (the first inactive day; NULL = open/ongoing)
// keeping them identical is what makes assembleIllnessEpisode byte-identical to the old
// change-log derivation (the "assembly output identical pre/post swap" acceptance).
//
// The flagged-situation toggle opens/closes rows through syncOpenIllnessEpisode, called
// INSIDE the same writeTx that flips situations.active (lib/settings/profile-attrs.ts),
// so the active-situation set and the open row never disagree ("never two truths").

import { db, writeTx } from "./db";
import { normalizeSituationName } from "./situations";
import type { IllnessEpisode } from "./symptom-episode";

export interface IllnessEpisodeRow {
  id: number;
  profile_id: number;
  situation: string;
  started_at: string | null;
  ended_at: string | null;
  note: string | null;
  outcome: string | null;
}

const COLS = "id, profile_id, situation, started_at, ended_at, note, outcome";

// Map a stored row to the derived-episode shape assembleIllnessEpisode consumes. The
// `id` rides along so surfaces can link to /medical/episodes/[id]; the derivations in
// symptom-episode.ts leave it undefined (they never had a row).
export function episodeRowToDerived(row: IllnessEpisodeRow): IllnessEpisode {
  return {
    id: row.id,
    situation: row.situation,
    start: row.started_at,
    end: row.ended_at,
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
// start is on-or-before it (null start = since before the log) and its exclusive end is
// strictly after it (null end = ongoing).
export function getEpisodeRowForDate(
  profileId: number,
  date: string
): IllnessEpisodeRow | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM illness_episodes
          WHERE profile_id = ?
            AND (started_at IS NULL OR started_at <= ?)
            AND (ended_at IS NULL OR ended_at > ?)
          ORDER BY started_at IS NULL, started_at DESC, id DESC
          LIMIT 1`
      )
      .get(profileId, date, date) as IllnessEpisodeRow | undefined) ?? null
  );
}

// The current OPEN row of a named situation (ended_at IS NULL), or null. NOCASE-matched
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
          WHERE profile_id = ? AND situation = ? COLLATE NOCASE AND ended_at IS NULL
          ORDER BY started_at IS NULL, started_at DESC, id DESC
          LIMIT 1`
      )
      .get(profileId, norm) as IllnessEpisodeRow | undefined) ?? null
  );
}

// All of a profile's episode rows, most-recent first (a known start outranks a
// before-log null start). Backs allEpisodesForProfile + the episodes index (#856 item 9).
export function listEpisodeRows(profileId: number): IllnessEpisodeRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM illness_episodes
        WHERE profile_id = ?
        ORDER BY started_at IS NULL, started_at DESC, id DESC`
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
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, ?, ?, NULL)`
    ).run(profileId, norm, onDate);
  } else {
    if (!open) return;
    // EXCLUSIVE end = the first inactive day (onDate), matching diffSituations' stop
    // event and the derivation's [start, end) semantics.
    db.prepare(
      `UPDATE illness_episodes SET ended_at = ?
        WHERE id = ? AND profile_id = ? AND ended_at IS NULL`
    ).run(onDate, open.id, profileId);
  }
}

// Retro-create a closed (or open) episode row directly — the item-1 "was sick last
// week, never toggled" path. Opens its own writeTx.
export function createEpisodeRow(
  profileId: number,
  situation: string,
  startedAt: string | null,
  endedAt: string | null,
  note: string | null = null,
  outcome: string | null = null
): number {
  const norm = normalizeSituationName(situation) || situation.trim();
  return writeTx(() =>
    Number(
      db
        .prepare(
          `INSERT INTO illness_episodes
             (profile_id, situation, started_at, ended_at, note, outcome)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(profileId, norm, startedAt, endedAt, note, outcome).lastInsertRowid
    )
  );
}

// Edit an episode's boundaries in place (item 1). A plain row UPDATE — derived
// membership follows the new [start, end) automatically. Opens its own writeTx.
export function updateEpisodeBoundaries(
  profileId: number,
  id: number,
  startedAt: string | null,
  endedAt: string | null
): boolean {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE illness_episodes SET started_at = ?, ended_at = ?
            WHERE id = ? AND profile_id = ?`
        )
        .run(startedAt, endedAt, id, profileId).changes > 0
  );
}

// Set the episode-level free-text note (item 8). Empty → NULL.
export function setEpisodeNote(
  profileId: number,
  id: number,
  note: string | null
): boolean {
  const v = note?.trim() ? note.trim() : null;
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE illness_episodes SET note = ? WHERE id = ? AND profile_id = ?`
        )
        .run(v, id, profileId).changes > 0
  );
}

// Set the episode outcome annotation (item 9 index column). Empty → NULL.
export function setEpisodeOutcome(
  profileId: number,
  id: number,
  outcome: string | null
): boolean {
  const v = outcome?.trim() ? outcome.trim() : null;
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE illness_episodes SET outcome = ? WHERE id = ? AND profile_id = ?`
        )
        .run(v, id, profileId).changes > 0
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
      keep.started_at == null || drop.started_at == null
        ? null
        : keep.started_at < drop.started_at
          ? keep.started_at
          : drop.started_at;
    // Union end: a null (open) end means the union is still open; else the later date.
    const end =
      keep.ended_at == null || drop.ended_at == null
        ? null
        : keep.ended_at > drop.ended_at
          ? keep.ended_at
          : drop.ended_at;
    db.prepare(
      `UPDATE illness_episodes SET started_at = ?, ended_at = ?
        WHERE id = ? AND profile_id = ?`
    ).run(start, end, keepId, profileId);
    db.prepare(
      `UPDATE profile_share_links SET episode_id = ?
        WHERE episode_id = ? AND profile_id = ?`
    ).run(keepId, dropId, profileId);
    db.prepare(
      `DELETE FROM illness_episodes WHERE id = ? AND profile_id = ?`
    ).run(dropId, profileId);
    return keepId;
  });
}
