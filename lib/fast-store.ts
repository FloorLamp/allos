// The stored fasting log (issue #2756). One `fasts` row per claimed fast — the
// interval and an optional note, nothing else: elapsed time, day attribution, the
// stale bound and the control's own label all stay DERIVED (lib/fasting.ts), so a
// timezone change or a bound the owner retunes never needs a data migration.
//
// Auth-blind (profileId-first, never imports lib/auth — #319): the Server Action owns
// the gate + revalidation. Every statement is profile-scoped (the scoping rule). This
// module holds the table's ONLY DML — it is the registered core in
// STATEFUL_WRITE_TABLES, and lib/fast-write.ts (the transitions + the adult-only gate)
// reaches the table exclusively through here.

import { db, writeTx } from "./db";
import type { Fast } from "./fasting";

const COLS = "id, started_at, ended_at, note";

/** One fast by id, scoped to the profile. */
export function getFast(profileId: number, id: number): Fast | null {
  return (
    (db
      .prepare(`SELECT ${COLS} FROM fasts WHERE id = ? AND profile_id = ?`)
      .get(id, profileId) as Fast | undefined) ?? null
  );
}

// The profile's ACTIVE fast (`ended_at IS NULL`), or null. The partial unique index
// (migration 20260816-fasts) makes at most one possible, so this is a lookup rather
// than a "pick the newest" heuristic — and every derivation downstream may assume it.
export function getActiveFast(profileId: number): Fast | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM fasts
          WHERE profile_id = ? AND ended_at IS NULL`
      )
      .get(profileId) as Fast | undefined) ?? null
  );
}

/** Every recorded fast for a profile, newest-started first. */
export function listFasts(profileId: number, limit?: number): Fast[] {
  const sql =
    `SELECT ${COLS} FROM fasts
      WHERE profile_id = ?
      ORDER BY started_at DESC, id DESC` + (limit != null ? " LIMIT ?" : "");
  const args: unknown[] = limit != null ? [profileId, limit] : [profileId];
  return db.prepare(sql).all(...args) as Fast[];
}

/** Completed fasts whose interval intersects [fromInstant, toInstant). */
export function listFastsInRange(
  profileId: number,
  fromInstant: string,
  toInstant: string
): Fast[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM fasts
        WHERE profile_id = ?
          AND started_at < ?
          AND (ended_at IS NULL OR ended_at >= ?)
        ORDER BY started_at ASC, id ASC`
    )
    .all(profileId, toInstant, fromInstant) as Fast[];
}

// Insert a fast. `endedAt` is null for the ordinary "start it now" case and non-null
// only when a completed interval is recorded in one go. Both instants arrive already
// serialized on the canonical convention by the write core (utcInstant/instantNow) —
// this module never builds one, which is what keeps `fasts` off SQLite's bare clock.
export function createFastRow(
  profileId: number,
  startedAt: string,
  endedAt: string | null,
  note: string | null
): number {
  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO fasts (profile_id, started_at, ended_at, note)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, startedAt, endedAt, note);
    return Number(info.lastInsertRowid);
  });
}

/** Absolute update of a fast's own fields, scoped to the profile. */
export function updateFastRow(
  profileId: number,
  id: number,
  startedAt: string,
  endedAt: string | null,
  note: string | null
): number {
  return writeTx(() => {
    const info = db
      .prepare(
        `UPDATE fasts SET started_at = ?, ended_at = ?, note = ?
          WHERE id = ? AND profile_id = ?`
      )
      .run(startedAt, endedAt, note, id, profileId);
    return info.changes;
  });
}

// Delete a fast. This is the DISCARD path's store half — "I never actually fasted",
// which is a row removal rather than a lifecycle transition, and is deliberately
// distinct from ending one at a backdated instant ("I stopped at some point"). The two
// are different truths and the stale suggest offers both rather than picking.
//
// NOT routed through the shared undo-delete machinery (lib/undo-delete-db.ts), and the
// reason is the row-op completeness rule rather than an omission: a `fasts` row has no
// children and no inbound foreign keys — nothing links to a fast — so removing it
// leaves nothing unreconciled and there is no multi-entity snapshot for that machinery
// to reassemble. Discard is reachable only from the stale suggest, where the user is
// answering a question about a fast they have already been told is 36 h old.
export function deleteFastRow(profileId: number, id: number): number {
  return writeTx(() => {
    const info = db
      .prepare(`DELETE FROM fasts WHERE id = ? AND profile_id = ?`)
      .run(id, profileId);
    return info.changes;
  });
}
