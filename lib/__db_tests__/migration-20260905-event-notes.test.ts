// #5304's migration: every note stored on a day counter moves onto ONE event of that
// day, on both ledgers, in the owner's two clauses (#5077): the day's FIRST derived
// event, once; a timeless event minted only where the day has no event at all.
//
// WHAT THIS FILE PINS is the choice of row and the count. "First derived" is
// `logged_via IS NULL` first, then the earliest — so a day with derived rows lands
// the note on a derived one even when a real tap is older, a day of real taps alone
// lands it on the earliest tap rather than minting a phantom beside them, and the
// mint reads the day row's own filing stamp. The neighbour profile's identical
// coordinate is the row a lost profile predicate would attach to instead.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS, migrationsBefore } from "@/lib/migrations/versions";
import { attachNotes } from "@/lib/migrations/versions/20260905-event-notes";

const MIGRATION = "20260905-event-notes";

function beforeNotes(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles(id, name) VALUES (1, 'Noted')").run();
  db.prepare("INSERT INTO profiles(id, name) VALUES (2, 'Neighbour')").run();
  return db;
}

type Row = Record<string, unknown>;
const substanceRows = (db: Database.Database, profileId: number) =>
  db
    .prepare(
      `SELECT date, substance, recorded_at, occurred_at, time_source, logged_via, notes
         FROM substance_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as Row[];
const foodRows = (db: Database.Database, profileId: number) =>
  db
    .prepare(
      `SELECT date, group_key, recorded_at, occurred_at, time_source, logged_via,
              meal_slot, notes
         FROM food_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as Row[];

describe("#5304 — a day's note moves onto one of its uses", () => {
  it("lands on the first derived use, else the earliest tap, else a minted timeless event", () => {
    const db = beforeNotes();
    const day = db.prepare(
      `INSERT INTO substance_daily_totals
         (profile_id, date, substance, units, recorded_at, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const use = db.prepare(
      `INSERT INTO substance_log_events
         (profile_id, substance, date, recorded_at, logged_via)
       VALUES (?, ?, ?, ?, ?)`
    );
    // A: two derived uses and an OLDER real tap — derived wins over age.
    day.run(1, "2026-08-01", "nicotine", 3, "2026-08-01T14:00:00Z", "balcony");
    use.run(1, "nicotine", "2026-08-01", "2026-08-01T09:00:00Z", "page");
    use.run(1, "nicotine", "2026-08-01", "2026-08-01T14:00:00Z", null);
    use.run(1, "nicotine", "2026-08-01", "2026-08-01T14:00:00Z", null);
    // B: real taps only — the earliest carries it; nothing is minted beside them.
    day.run(1, "2026-08-02", "nicotine", 2, "2026-08-02T20:00:00Z", "late");
    use.run(1, "nicotine", "2026-08-02", "2026-08-02T20:00:00Z", "page");
    use.run(1, "nicotine", "2026-08-02", "2026-08-02T18:00:00Z", "quick-log");
    // C: a note and no use at all — one timeless event, on the day's own stamp.
    day.run(
      1,
      "2026-08-03",
      "cannabis",
      0,
      "2026-08-03T11:00:00Z",
      "only a note"
    );
    // D: no note — untouched.
    day.run(1, "2026-08-04", "nicotine", 1, "2026-08-04T08:00:00Z", null);
    use.run(1, "nicotine", "2026-08-04", "2026-08-04T08:00:00Z", null);
    // The neighbour's identical coordinate, noted differently.
    day.run(2, "2026-08-01", "nicotine", 1, "2026-08-01T14:00:00Z", "theirs");
    use.run(2, "nicotine", "2026-08-01", "2026-08-01T14:00:00Z", null);

    runMigrations(db, MIGRATIONS);

    const notes = (rows: Row[]) => rows.map((row) => [row.date, row.notes]);
    expect(notes(substanceRows(db, 1))).toEqual([
      ["2026-08-01", null],
      ["2026-08-01", "balcony"],
      ["2026-08-01", null],
      ["2026-08-02", null],
      ["2026-08-02", "late"],
      ["2026-08-04", null],
      ["2026-08-03", "only a note"],
    ]);
    expect(substanceRows(db, 1).at(-1)).toEqual({
      date: "2026-08-03",
      substance: "cannabis",
      recorded_at: "2026-08-03T11:00:00Z",
      occurred_at: null,
      time_source: null,
      logged_via: null,
      notes: "only a note",
    });
    expect(notes(substanceRows(db, 2))).toEqual([["2026-08-01", "theirs"]]);
    // The day columns are copied from, not cleared.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE notes IS NOT NULL`
        )
        .get()
    ).toEqual({ n: 4 });

    // REPLAY IS A NO-OP, run rather than asserted past the ALTER.
    const before = [substanceRows(db, 1), substanceRows(db, 2)];
    attachNotes(db);
    expect([substanceRows(db, 1), substanceRows(db, 2)]).toEqual(before);
  });

  it("does the same on the food ledger, restating the day's bare created_at for a mint", () => {
    const db = beforeNotes();
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings, notes, created_at)
       VALUES (1, '2026-08-05', 'alcohol', 2, 'wedding', '2026-08-05 21:10:00'),
              (1, '2026-08-06', 'alcohol', 0, 'dry night', '2026-08-06 09:00:00'),
              (1, '2026-08-06', 'berries', 1, NULL, '2026-08-06 09:00:00')`
    ).run();
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at, logged_via)
       VALUES (1, 'alcohol', '2026-08-05', '2026-08-05T22:00:00Z', 'page'),
              (1, 'alcohol', '2026-08-05', '2026-08-05T21:10:00Z', NULL),
              (1, 'berries', '2026-08-06', '2026-08-06T09:00:00Z', 'page')`
    ).run();

    runMigrations(db, MIGRATIONS);

    expect(foodRows(db, 1)).toEqual([
      expect.objectContaining({ date: "2026-08-05", notes: null }),
      expect.objectContaining({ date: "2026-08-05", notes: "wedding" }),
      expect.objectContaining({ group_key: "berries", notes: null }),
      {
        date: "2026-08-06",
        group_key: "alcohol",
        recorded_at: "2026-08-06T09:00:00Z",
        occurred_at: null,
        time_source: null,
        logged_via: null,
        meal_slot: null,
        notes: "dry night",
      },
    ]);
    const before = foodRows(db, 1);
    attachNotes(db);
    expect(foodRows(db, 1)).toEqual(before);
  });
});
