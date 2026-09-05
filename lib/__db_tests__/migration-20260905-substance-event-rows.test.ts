// #5026 phase 2's migration, and what it decides about everything logged before it.
//
// The change makes the record read EVENTS, so a counter row with no events behind it
// counts on the card and against the weekly cap while showing nothing in the record —
// the state item 3 names and #5085 measures from the alcohol side. The migration's
// answer is that a counter row's units ARE events and it creates the missing ones, on
// both ledgers, inventing no use instant.
//
// WHAT THIS FILE PINS is the pair a reader has to be able to trust: the derived rows
// are THERE (so nothing logged before this change left the record), and their
// `occurred_at` is NULL (so nothing claims to know when a legacy use happened). A test
// that asserted only the first would pass on a migration that filled the instant in
// from the filing stamp, which is the failure the decision exists to refuse.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS, migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260905-substance-event-rows";

const MIGRATION = "20260905-substance-event-rows";

interface DerivedRow {
  date: string;
  recorded_at: string;
  occurred_at: string | null;
  time_source: string | null;
}

function beforeEvents(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles(id, name) VALUES (1, 'Legacy')").run();
  db.prepare("INSERT INTO profiles(id, name) VALUES (2, 'Neighbour')").run();
  return db;
}

function substanceEvents(db: Database.Database, profileId: number) {
  return db
    .prepare(
      `SELECT date, recorded_at, occurred_at, time_source
         FROM substance_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as DerivedRow[];
}

function alcoholEvents(db: Database.Database, profileId: number) {
  return db
    .prepare(
      `SELECT date, recorded_at, occurred_at, time_source
         FROM food_log_events
        WHERE profile_id = ? AND group_key = 'alcohol' ORDER BY id`
    )
    .all(profileId) as DerivedRow[];
}

describe("#5026 phase 2 — pre-ledger rows become uses, with no invented instant", () => {
  it("derives one event per outstanding unit and states no time for any of them", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (5, 1, '2026-08-01', 'nicotine', 3, '2026-08-01T14:32:00Z')`
    ).run();
    // A second profile's day, so the derivation is shown to be per-row rather than a
    // sweep that happens to be right when one profile has everything.
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (6, 2, '2026-08-02', 'Kratom', 1, '2026-08-02T07:00:00Z')`
    ).run();
    runMigrations(db, MIGRATIONS);

    // THREE rows for a count of three, each carrying the DAY's filing stamp — the only
    // one the counter remembers — and NO use instant. `eventInstant` answers
    // `not-recorded` for these, which is the honest answer and the reason a converted
    // legacy day adds rows to the record and draws no ticks on the rail.
    const shared = {
      date: "2026-08-01",
      recorded_at: "2026-08-01T14:32:00Z",
      occurred_at: null,
      time_source: null,
    };
    expect(substanceEvents(db, 1)).toEqual([shared, shared, shared]);
    expect(substanceEvents(db, 2)).toEqual([
      {
        date: "2026-08-02",
        recorded_at: "2026-08-02T07:00:00Z",
        occurred_at: null,
        time_source: null,
      },
    ]);
    // The counters are untouched: the migration adds the missing half, it does not
    // move the half that was already right.
    expect(
      db
        .prepare(`SELECT units FROM substance_daily_totals ORDER BY profile_id`)
        .all()
    ).toEqual([{ units: 3 }, { units: 1 }]);
  });

  // ITEM 3. An alcohol day whose events never existed (a pre-#950 row) counts on the
  // card and against the cap while the record — which reads the events — shows nothing.
  // It is a RESIDUAL row, not nothing, so its uses are materialized rather than its
  // count discarded. `food_daily_totals.created_at` is the `bare` convention, so the
  // stamp is canonicalized on the way in and reads like every tap-written neighbour.
  it("materializes the orphan alcohol day's drinks, canonicalizing its filing stamp", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (7, 1, '2026-08-02', 'alcohol', 2, '2026-08-02 19:00:00')`
    ).run();
    runMigrations(db, MIGRATIONS);
    const drink = {
      date: "2026-08-02",
      recorded_at: "2026-08-02T19:00:00Z",
      occurred_at: null,
      time_source: null,
    };
    expect(alcoholEvents(db, 1)).toEqual([drink, drink]);
  });

  it("tops up a SHORTFALL rather than duplicating the events a day already has", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (8, 1, '2026-08-03', 'alcohol', 3, '2026-08-03 18:00:00')`
    ).run();
    // One real tap already stands for one of the three, with a stated hour on it.
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, recorded_at, occurred_at, time_source)
       VALUES (1, 'alcohol', '2026-08-03', '2026-08-03T21:05:00Z',
               '2026-08-03T21:00:00Z', 'stated')`
    ).run();
    runMigrations(db, MIGRATIONS);

    // Three rows, not four: the stated one survives untouched and TWO were derived.
    // This is the assertion that would fail on a migration written as "insert `units`
    // rows", which is the obvious spelling and the one that doubles a live day.
    expect(alcoholEvents(db, 1)).toEqual([
      {
        date: "2026-08-03",
        recorded_at: "2026-08-03T21:05:00Z",
        occurred_at: "2026-08-03T21:00:00Z",
        time_source: "stated",
      },
      {
        date: "2026-08-03",
        recorded_at: "2026-08-03T18:00:00Z",
        occurred_at: null,
        time_source: null,
      },
      {
        date: "2026-08-03",
        recorded_at: "2026-08-03T18:00:00Z",
        occurred_at: null,
        time_source: null,
      },
    ]);
  });

  // RE-RUN THE `up` DIRECTLY, not `runMigrations` twice. The runner is name-keyed, so
  // a second `runMigrations` records the name and SKIPS — which would make this pass
  // without the backfill SQL being idempotent at all, and the shortfall arithmetic is
  // exactly what would then go unwatched.
  it("is a no-op when its own up() runs again", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (9, 1, '2026-08-04', 'cannabis', 2, '2026-08-04T22:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (10, 1, '2026-08-04', 'alcohol', 1, '2026-08-04 20:00:00')`
    ).run();
    runMigrations(db, MIGRATIONS);
    const first = [substanceEvents(db, 1), alcoholEvents(db, 1)];
    // The CREATE is `IF NOT EXISTS`; the column ALTER is not, and re-running it is the
    // one statement here that cannot be idempotent, so it is expected to throw and the
    // backfills are what this asserts about.
    expect(() => up(db)).toThrow(/duplicate column/i);
    expect([substanceEvents(db, 1), alcoholEvents(db, 1)]).toEqual(first);
  });

  // A non-alcohol food group is deliberately OUT of item 3's scope: the same shortfall
  // exists there, but the surfaces that disagree about it are nutrition's, not the
  // substance card and its cap. Pinned so the boundary is a decision on record rather
  // than an omission somebody later reads as one.
  it("leaves a non-alcohol food group's shortfall alone", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (11, 1, '2026-08-05', 'vegetables', 4, '2026-08-05 12:00:00')`
    ).run();
    runMigrations(db, MIGRATIONS);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ?`
        )
        .get(1)
    ).toEqual({ n: 0 });
  });
});
