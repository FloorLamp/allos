// The stored fasting log (issue #2756). One `fasts` row per claimed fast — the
// interval and an optional note, nothing else: elapsed time, day attribution, the
// stale bound and the control's own label all stay DERIVED (lib/fasting.ts), so a
// timezone change or a bound the owner retunes never needs a data migration.
//
// Auth-blind (profileId-first, never imports lib/auth — #319): the Server Action owns
// the gate + revalidation. Every statement is profile-scoped (the scoping rule, which
// now HOLDS it there — `fasts` is in OWNED_TABLES, so the leak scan reads these
// statements). This module holds every DML that NAMES the table — it is the registered
// core in STATEFUL_WRITE_TABLES, and lib/fast-write.ts (the transitions + the
// adult-only gate) reaches the table exclusively through here.
//
// One runtime write is not here and is named rather than left to be discovered: Data →
// Manage's bulk row DELETE builds its statement from the whitelisted dataset table
// (lib/export.ts's `fasts` dataset + DELETE_POLICY), so it never spells `fasts` in
// source. That is a row removal, not one of this machine's transitions — it cannot mint
// a second active fast, and REDUCING fasting state is what the life-stage exemption
// already permits. Any write that would CREATE or REOPEN a fast still has to come
// through here.

import { db, writeTx } from "./db";
import type { Fast } from "./fasting";

const COLS = "id, started_at, ended_at, note";

// A fast's END, as stored: the instant it CLAIMS, and the instant that claim was
// WRITTEN. ONE value rather than two parameters, because the two are only ever set
// together and only ever cleared together — an `ended_at` with no write stamp beside it
// is a row this module cannot express, so the case does not need a guard anywhere.
//
// The distinction is the whole point of the second column. `at` is a claim the user is
// invited to backdate; `writtenAt` is the app's own clock at the write and is what
// bounds the Undo (lib/fast-write.ts's `too-old`).
export interface FastEnd {
  /** The claimed end instant, canonical (`utcInstant`). */
  at: string;
  /** The app's clock when that end was written, canonical (`utcInstant`). */
  writtenAt: string;
}

// A fast as the WRITE tier sees it: the reader's `Fast` plus the end's write stamp.
// Deliberately not folded into `Fast` — no reader, no page prop and no pure derivation
// has a question this column answers, and widening the shared shape would ship it to
// every surface that renders a fast.
export interface StoredFast extends Fast {
  end_written_at: string | null;
}

// One fast by id, scoped to the profile — the WRITE tier's read (its only callers are
// `reopenFast`, `discardFast` and `editFast`), so it carries the end's write stamp.
// `editFast` needs it to write the stamp back UNCHANGED: correcting an interval is not
// an end, so it must not restart the Undo's clock (lib/fast-write.ts).
export function getFast(profileId: number, id: number): StoredFast | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS}, end_written_at FROM fasts WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as StoredFast | undefined) ?? null
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

// Every recorded fast for a profile, newest-started first. `limit` binds through a
// LIMIT that is always PRESENT in the statement text — `-1` is SQLite's own "no limit"
// — rather than being concatenated in, so this stays one literal prepared statement and
// the profile-scoping scan can read its WHERE clause.
export function listFasts(profileId: number, limit?: number): Fast[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM fasts
        WHERE profile_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, limit ?? -1) as Fast[];
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

// Insert a fast. `end` is null for the ordinary "start it now" case and a `FastEnd` only
// when a completed interval is recorded in one go. Every instant arrives already
// serialized on the canonical convention by the write core (utcInstant/instantNow) —
// this module never builds one, which is what keeps `fasts` off SQLite's bare clock.
export function createFastRow(
  profileId: number,
  startedAt: string,
  end: FastEnd | null,
  note: string | null
): number {
  return writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO fasts (profile_id, started_at, ended_at, end_written_at, note)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, startedAt, end?.at ?? null, end?.writtenAt ?? null, note);
    return Number(info.lastInsertRowid);
  });
}

// Absolute update of a fast's own fields, scoped to the profile. The end is ONE
// argument, so `ended_at` and `end_written_at` cannot be set apart: reopening passes
// null and clears both, ending passes the claimed instant with the clock reading of the
// write beside it, and a CORRECTION (`editFast`) passes the new claimed instant with the
// row's EXISTING stamp — a closed row with no write stamp stays inexpressible either way.
export function updateFastRow(
  profileId: number,
  id: number,
  startedAt: string,
  end: FastEnd | null,
  note: string | null
): number {
  return writeTx(() => {
    const info = db
      .prepare(
        `UPDATE fasts SET started_at = ?, ended_at = ?, end_written_at = ?, note = ?
          WHERE id = ? AND profile_id = ?`
      )
      .run(
        startedAt,
        end?.at ?? null,
        end?.writtenAt ?? null,
        note,
        id,
        profileId
      );
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
// to reassemble.
//
// WHAT BOUNDS THIS, STATED AS A FACT ABOUT THE CODE. The only SURFACE that offers
// discard is the stale suggest, where the user is answering a question about a fast they
// have already been told is 36 h old — but `discardFast` takes an id from a form and a
// Server Action is independently POST-callable, so the surface is not a bound and this
// comment does not claim it as one. Two bounds are real. The statement is
// profile-scoped, so no other profile's data is reachable and no fasting state is
// created. And `discardFast` re-reads the row under the write lock and refuses one that
// is already CLOSED, so this statement only ever removes the fast that is RUNNING — the
// stale tab whose button still carries a since-ended row's id gets a typed refusal
// rather than a silent delete of finished history.
export function deleteFastRow(profileId: number, id: number): number {
  return writeTx(() => {
    const info = db
      .prepare(`DELETE FROM fasts WHERE id = ? AND profile_id = ?`)
      .run(id, profileId);
    return info.changes;
  });
}
