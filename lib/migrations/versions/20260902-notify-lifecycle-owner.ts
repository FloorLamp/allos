import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2565 — the delivery-health marker becomes SCOPED: one `notify_lifecycle` row
// per delivery owner (a login for Telegram/Push/Email, a profile for Home Assistant)
// beside the #942 instance-wide row. `owner_id` is that owner; a scoped row's `key` is
// `delivery:<channel>:<owner>` (lib/notifications/delivery-marker.ts).
//
// NO BACKFILL, DELIBERATELY. The pre-#2565 row ('delivery-health', owner_id NULL) said a
// channel failed about nobody in particular, and nothing recorded WHOSE send it was.
// Rewriting it into owner rows would invent a per-owner state the owner ruling forbids
// (a configured channel with no completed attempt may never be called Delivering, and
// the same discipline applies to Erroring). So the legacy row stays as the aggregate
// reader's honest fallback until the first scoped attempt on its channel retires it.
//
// NOT profile-owned: `owner_id` is a login for three of the four channels, so the table
// stays outside lib/owned-tables.ts as it always was; a deleted profile's Home Assistant
// row is a dead id-keyed row carrying an error sentence and no PHI, the same class as
// the `notify_mute_profile_<id>` login keys. Nullable, plain INTEGER, no index — the
// surface reads a handful of rows by key.
//
// Determinism: adds a column only. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(notify_lifecycle)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("owner_id")) return;
  db.exec(`ALTER TABLE notify_lifecycle ADD COLUMN owner_id INTEGER`);
}

export const migration: Migration = {
  name: "20260902-notify-lifecycle-owner",
  up,
};
