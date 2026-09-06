import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3285 item 2 — the auto-link OPT-OUT.
//
// `20260906-event-activity-link` gave an activity its event link and the sync an
// auto-link: a race-labelled session attaches to that day's event. That inference
// re-runs after EVERY value-changing re-sync, so a person who UNLINKS a session by
// hand — saying it is not that event's result — has the decision reverted by the next
// title fix arriving from the provider. This column remembers the decision.
//
// WHY NOT `edited`. The #133 edit lock already means "a person has been in this row,
// so the source must not overwrite it", and setting it here would work. It costs too
// much: it holds the WHOLE row out of re-ingest (the provider stops correcting the
// session's distance, duration and heart rate) and badges it "<source> · edited" with
// the sync-resume affordance, and it stays set after the person re-links. Detaching a
// session from an event should stop exactly one thing — the auto-link. One flag, one
// consequence. Declared as its own family in the side-state census
// (lib/side-state.ts) and read only through `isEventLinkOptedOut`.
//
// Replay-safe: the DB tier replays migrations through the non-version-gated
// migrate() wrapper, and SQLite has no ADD COLUMN IF NOT EXISTS. A constant DEFAULT
// makes ADD COLUMN NOT NULL legal without rewriting the table.
// Determinism: adds a column. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(activities)").all() as { name: string }[]
    ).map((c) => c.name)
  );
  if (!columns.has("endurance_link_optout")) {
    db.exec(
      `ALTER TABLE activities ADD COLUMN endurance_link_optout INTEGER NOT NULL
         DEFAULT 0;`
    );
  }
}

export const migration: Migration = {
  name: "20260906-event-link-optout",
  up,
};
