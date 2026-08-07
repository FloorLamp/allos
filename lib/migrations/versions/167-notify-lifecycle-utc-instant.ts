import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 167 (issue #2233): normalize `notify_lifecycle.at` onto the canonical
// stored-instant convention, 'YYYY-MM-DDTHH:MM:SSZ'.
//
// The delivery-health marker's `at` was written with `new Date().toISOString()` —
// millisecond precision plus `Z` ('2026-08-06T17:42:11.482Z'). That is a THIRD
// serialization in a schema whose entire point after #2205 phase 1 is that there are
// two: the canonical second-resolution `…SSZ` (lib/date.ts utcInstant) and SQLite's
// bare 'YYYY-MM-DD HH:MM:SS'. Phase 1's writer scan structurally could not see it —
// the module that builds the string (lib/notifications/index.ts) writes no SQL of its
// own; the #2205 phase 3 census (lib/time-columns.ts) is what surfaced it.
//
// VALUE-PRESERVING BY CONSTRUCTION, up to sub-second precision. The value is already
// UTC and already carries its `Z`; the rewrite only drops the fractional seconds
// ('.482'), which no reader ever consumed — the marker's `at` is displayed on the
// Settings surface through formatTimestamp and compared nowhere. Nothing compares
// this column in SQL today (verified by audit for #2233), so the rewrite has no
// query to fix alongside; converting NOW, before anything does compare it, is what
// keeps the mixed precision from ever becoming a lexical-comparison hazard
// ('…11.482Z' sorts after '…11Z' for the same second, so a `>=` boundary would
// silently drop or keep the wrong row).
//
// UPDATE-in-place, not a rebuild: the column has no DEFAULT to fix (migration 061
// created it as a plain nullable TEXT), so unlike 163/164 there is no bare-shaped
// clock waiting to re-introduce the old shape — the only writer is
// lib/notifications/index.ts, which binds instantNow() as of this change.
//
// REPLAY-SAFE. The DB test tier replays migrations through the non-version-gated
// migrate() wrapper. The rewrite is GLOB-guarded to the fractional-seconds shape, so
// a second run matches nothing and is a no-op. Values already canonical, the empty
// string migration 061's legacy copy could have stored, and NULL are all left
// untouched — the guard requires a well-formed 'YYYY-MM-DDTHH:MM:SS.' prefix, and
// `substr(at, 1, 19)` keeps exactly those stated digits.

// 'YYYY-MM-DDTHH:MM:SS.<fraction>Z' — the shape `new Date().toISOString()` writes
// (the fraction is always three digits there, but any length is normalized the same
// way). GLOB is case-sensitive and `.` is literal in it; a value already on the
// canonical second-resolution shape has no '.' at position 20 and never matches.
const ISO_MS_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].*Z";

export function up(db: Database.Database): void {
  db.prepare(
    `UPDATE notify_lifecycle
        SET at = substr(at, 1, 19) || 'Z'
      WHERE at GLOB '${ISO_MS_GLOB}'`
  ).run();
}

export const migration: Migration = {
  id: 167,
  name: "167-notify-lifecycle-utc-instant",
  up,
};
