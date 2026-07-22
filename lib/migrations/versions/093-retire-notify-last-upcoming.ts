import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 093 (issue #1108 — merge the morning digest and the "what's due" digest
// into ONE message). The separate "what's due" upcoming digest is retired: its
// content is now the morning digest's Today section (one message, one due-today
// computation over collectUpcoming), so the two per-day markers collapse to ONE
// (`notify_last_digest`) and the second marker, `notify_last_upcoming`, is dead.
//
// This is a #203 string-keyed-leftover cleanup: `notify_last_upcoming` is a
// per-profile settings key (a per-day date value written by the old runUpcomingDigest
// send path), and once nothing reads it the stored rows are inert dead rows. Unlike an
// id-keyed leftover they can never cause WRONG behavior (the key is gone from the code,
// so nothing re-keys onto it), but the same discipline that retired the legacy
// `notify_last_error*` keys in migration 061 applies: sweep the retired key so
// profile_settings holds one source of truth. One-shot by version; idempotent on
// replay (a second run finds no rows to delete).

export function up(db: Database.Database): void {
  // Defensive: a schema without profile_settings has nothing to sweep.
  const hasTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_settings'"
    )
    .get();
  if (!hasTable) return;
  db.prepare(
    "DELETE FROM profile_settings WHERE key = 'notify_last_upcoming'"
  ).run();
}

export const migration: Migration = {
  id: 93,
  name: "093-retire-notify-last-upcoming",
  up,
};
