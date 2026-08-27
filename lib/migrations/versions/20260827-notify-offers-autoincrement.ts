import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3282 — stop `notify_offers.id` recycling, because the id IS the token.
//
// THE DEFECT. `20260819-notify-offers` declared `id INTEGER PRIMARY KEY` with no
// `AUTOINCREMENT`, so SQLite hands a freed rowid to the next insert. A button's
// callback token is `<prefix>:<profileId>:<offerId>` and nothing else, so once the
// offer row is pruned and its id reissued, a button still sitting in the chat resolves
// to a DIFFERENT bundle — one it never named — and redeems it in full.
//
// The intersection rule does not cover this. It bounds HOW MUCH a tap writes, not
// WHAT: a reissued id supplies a fresh, fully-standing bundle, so the intersection is
// total. Observed on a stack keyboard — a "Sleep stack" button writing two
// antihypertensives, answered as a success because the tap did log something.
//
// AND THE TWO HORIZONS ARE THE SAME NUMBER. `OFFER_RETENTION_DAYS` and
// `MESSAGE_POINTER_RETENTION_DAYS` are both 3, so the offer becomes prunable — its id
// reusable — on exactly the day the reconcile sweep loses the pointer it needs to
// retire the button. The defence closes as the hazard opens. Every other dose token
// (`take:`, `all:`, and `stacktake:` before #3282) carries its day IN the token and so
// refuses itself once stale; an offer-id token cannot, because its referent is
// re-dated underneath it.
//
// THE REBUILD. SQLite cannot add `AUTOINCREMENT` in place, so this is the documented
// create-scratch → copy → drop → rename (migrations 006/011/015/016/018). Safe here:
// the table is days old, prune-bounded, and has NO FK children — nothing references
// it, as `20260819-notify-offers` states and `lib/owned-tables.ts` corroborates. The
// runner applies migrations with `foreign_keys = OFF` and restores it after, which is
// what the swap requires. Ids are PRESERVED in the copy, so a token that is still live
// keeps naming its own offer across the migration.
//
// THE FLOOR, AND WHY `AUTOINCREMENT` ALONE IS NOT ENOUGH. `AUTOINCREMENT` continues
// from the highest id PRESENT, so it can still reissue an id that was handed out
// before the table was last emptied — and an empty table (a quiet instance, or every
// row pruned) would restart the counter at 1, reproducing the defect for one more
// prune cycle. So the sequence is seeded past any id this table could have issued in
// its life: it was created 2026-08-19, offers are minted per profile per send, and
// pruned at 3 days, so a household could not have reached five figures. One million
// clears that by two orders of magnitude and costs nothing — the token is
// constant-size and an id of 19 digits still fits Telegram's 64 bytes
// (lib/__tests__/callback-data.test.ts pins it at 2^63-1).
//
// REPLAY SAFETY. The non-version-gated `migrate()` test wrapper replays `up()` on an
// already-converged DB, so the rebuild is guarded by a sentinel read off the LIVE
// schema (`AUTOINCREMENT` in the table's own DDL). A second run is a pure no-op.
// Determinism: reads only the DB and the constant below.
const ID_FLOOR = 1_000_000;

export const migration: Migration = {
  name: "20260827-notify-offers-autoincrement",
  up(db: Database.Database) {
    const ddl = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notify_offers'`
        )
        .get() as { sql: string | null } | undefined
    )?.sql;
    if (ddl == null) return; // absent (partial handle) — nothing to rebuild
    if (ddl.includes("AUTOINCREMENT")) return; // already converged

    db.exec(`
      CREATE TABLE notify_offers__rebuild (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
         family     TEXT NOT NULL,
         date       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at TEXT NOT NULL
       );
      INSERT INTO notify_offers__rebuild (id, profile_id, family, date, payload, created_at)
        SELECT id, profile_id, family, date, payload, created_at FROM notify_offers;
      DROP TABLE notify_offers;
      ALTER TABLE notify_offers__rebuild RENAME TO notify_offers;
      CREATE INDEX IF NOT EXISTS idx_notify_offers_profile
        ON notify_offers(profile_id, date);
    `);
    // After the rename, so the row is already keyed to the final name. DELETE-then-
    // INSERT rather than `INSERT OR REPLACE`: `sqlite_sequence` is declared without a
    // unique constraint on `name`, so OR REPLACE has nothing to conflict on and simply
    // appends a second row, leaving the counter where it was. (Measured — the floor
    // silently did not apply until this was written as a delete.)
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'notify_offers'`);
    db.prepare(
      `INSERT INTO sqlite_sequence (name, seq)
       VALUES ('notify_offers', MAX(?, COALESCE((SELECT MAX(id) FROM notify_offers), 0)))`
    ).run(ID_FLOOR);
  },
};
