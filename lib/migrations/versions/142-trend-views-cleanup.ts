import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 142 (issue #1869 item 4): delete the inert `trend_views` rows from
// `profile_settings`.
//
// #1653's Trends overhaul removed the Views strip, its three Server Actions, the
// pure list math (lib/trend-views.ts) and the `getTrendViews`/`setTrendViews`
// settings accessors — with no reader or writer left, the stored per-profile JSON
// blobs became inert. Rows stayed behind because retiring the accessors needed no
// schema change; but a leftover row under a REUSABLE key silently re-attaches to
// whatever next claims that key (the #203 rule migration 113 already applied to
// `trend_pins`), and a one-shot data move belongs in a migration, not a settings
// flag (house rule). So the sweep runs once, versioned, here.
//
// `trend_pins` is included in the same DELETE as a belt: migration 113 already
// deleted those rows and nothing has written the key since (its accessors went in
// the same change), so this normally deletes zero rows — but the two keys retire
// as one family and the sweep is free.
//
// Self-contained (manifest freeze — imports nothing from lib/), replay-safe (a
// plain idempotent DELETE; baseline replays recreate an empty profile_settings),
// and deterministic (reads nothing but the DB).

export function up(db: Database.Database): void {
  db.prepare(
    `DELETE FROM profile_settings WHERE key IN ('trend_views', 'trend_pins')`
  ).run();
}

export const migration: Migration = {
  id: 142,
  name: "142-trend-views-cleanup",
  up,
};
