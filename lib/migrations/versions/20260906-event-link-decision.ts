import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3285 item 2 — the event link's decision ORDER.
//
// `20260906-event-link-optout` recorded THAT a person had set this session's event
// link by hand, as a 0/1 flag. A flag cannot say WHEN, and a merge needs exactly
// that: when two copies of one session each carry a decision, the cluster keeps ONE
// link, and the only defensible answer is the person's LATEST word. Keepership is not
// recency — it is chosen by richness and token order — so a keeper-first fold reverted
// a hand link, or a "Move here", to whatever the other copy said, invisibly and with
// the person doing nothing.
//
// This column replaces the flag with the DECISION ORDINAL: 0 = nobody has decided,
// N > 0 = this row's link was set by hand as the profile's Nth such decision. Strictly
// increasing per profile, so two decisions can always be ordered.
//
// WHY AN ORDINAL AND NOT A TIMESTAMP. The rule needs an order, not a time: nothing in
// the app shows when a link was decided. A wall clock stores more than the rule needs
// and still ties — two writes inside the same millisecond, or a clock that steps back,
// leave the fold guessing again, which is the defect this replaces. A counter taken
// under the write lock cannot tie.
//
// The old flag's values carry over as ordinal 1: a decision was made, and the flag
// never knew more than that. They tie with each other, which is exactly the ordering
// the flag had.
//
// Replay-safe: the DB tier replays migrations through the non-version-gated migrate()
// wrapper, and SQLite has no ADD COLUMN IF NOT EXISTS. A constant DEFAULT makes ADD
// COLUMN NOT NULL legal without rewriting the table; the backfill and the drop are
// both guarded on the old column still being there, so a second pass is a no-op.
// SQLite ≥ 3.35 supports DROP COLUMN (migration 094 is the precedent); no index or
// view names the dropped column.
// Determinism: adds a column, copies one column into it, drops the old one.
export function up(db: Database.Database): void {
  const columns = () =>
    new Set(
      (
        db.prepare("PRAGMA table_info(activities)").all() as { name: string }[]
      ).map((c) => c.name)
    );
  if (!columns().has("endurance_link_decided_seq")) {
    db.exec(
      `ALTER TABLE activities ADD COLUMN endurance_link_decided_seq INTEGER
         NOT NULL DEFAULT 0;`
    );
  }
  if (columns().has("endurance_link_optout")) {
    db.exec(
      `UPDATE activities SET endurance_link_decided_seq = 1
        WHERE endurance_link_optout = 1 AND endurance_link_decided_seq = 0;`
    );
    db.exec(`ALTER TABLE activities DROP COLUMN endurance_link_optout;`);
  }
}

export const migration: Migration = {
  name: "20260906-event-link-decision",
  up,
};
