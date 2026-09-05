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
import { backfill } from "@/lib/migrations/versions/20260905-substance-event-rows";

const MIGRATION = "20260905-substance-event-rows";

interface DerivedRow {
  date: string;
  recorded_at: string;
  occurred_at: string | null;
  time_source: string | null;
  substance?: string;
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

/** The same rows plus the key, for the one case that seeds a second substance. */
function substanceEventsByKey(db: Database.Database, profileId: number) {
  return db
    .prepare(
      `SELECT date, substance, recorded_at, occurred_at, time_source
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

  // THE SHORTFALL IS A SUBTRACTION, AND THE SUBTRACTION COUNTS ONLY THIS ROW'S OWN
  // EVENTS. Both arms measure `counter − events already standing`, and each arm's count
  // is scoped by three predicates: the day row's profile, its date, and its key (the
  // substance, or `group_key = 'alcohol'`). A fixture with one profile, one day and one
  // key satisfies all three by accident, so this one seeds a DECOY against each: a
  // neighbour profile's use on the same day, the same profile's use of a DIFFERENT key
  // on the same day, and the same profile's use of the same key on a DIFFERENT day.
  // None of them may reduce this day's shortfall, and each is the row that makes one
  // deleted predicate visible. `units`/`servings` of 3 against ONE real event is what
  // watches the subtraction itself: written as "insert the count" the day would end at
  // four rows.
  it("counts only this row's own events when it measures the shortfall", () => {
    // Seeded AFTER the schema step and replayed through `backfill` — the only way to
    // put a pre-existing `substance_log_events` decoy in front of the substance arm,
    // since that table does not exist until this migration creates it. Same two
    // statements, run the same way the migration runs them.
    const db = beforeEvents();
    runMigrations(db, MIGRATIONS);
    const day = "2026-08-03";
    const other = "2026-08-02";
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (8, 1, ?, 'nicotine', 3, '2026-08-03T18:00:00Z')`
    ).run(day);
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (9, 1, ?, 'alcohol', 3, '2026-08-03 18:00:00')`
    ).run(day);
    // ONE real tap on each ledger, with a stated hour, standing for one of the three.
    db.prepare(
      `INSERT INTO substance_log_events
         (profile_id, substance, date, recorded_at, occurred_at, time_source)
       VALUES (1, 'nicotine', ?, '2026-08-03T21:05:00Z', '2026-08-03T21:00:00Z',
               'stated')`
    ).run(day);
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, recorded_at, occurred_at, time_source)
       VALUES (1, 'alcohol', ?, '2026-08-03T21:05:00Z', '2026-08-03T21:00:00Z',
               'stated')`
    ).run(day);
    // The three decoys, per ledger.
    for (const [sql, binds] of [
      [
        `INSERT INTO substance_log_events (profile_id, substance, date, recorded_at)
         VALUES (2, 'nicotine', ?, '2026-08-03T12:00:00Z')`,
        [day],
      ],
      [
        `INSERT INTO substance_log_events (profile_id, substance, date, recorded_at)
         VALUES (1, 'cannabis', ?, '2026-08-03T13:00:00Z')`,
        [day],
      ],
      [
        `INSERT INTO substance_log_events (profile_id, substance, date, recorded_at)
         VALUES (1, 'nicotine', ?, '2026-08-02T13:00:00Z')`,
        [other],
      ],
      [
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (2, 'alcohol', ?, '2026-08-03T12:00:00Z')`,
        [day],
      ],
      [
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (1, 'vegetables', ?, '2026-08-03T13:00:00Z')`,
        [day],
      ],
      [
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (1, 'alcohol', ?, '2026-08-02T13:00:00Z')`,
        [other],
      ],
    ] as const)
      db.prepare(sql).run(...binds);

    backfill(db);

    // THREE on the day, not four and not two: the stated tap survives untouched and TWO
    // were derived, on each ledger. Written as "insert the count" this is four; with
    // any one of the three scoping predicates dropped it is two, because a decoy has
    // been counted against this day's shortfall.
    const derived = {
      date: day,
      recorded_at: "2026-08-03T18:00:00Z",
      occurred_at: null,
      time_source: null,
    };
    const stated = {
      date: day,
      recorded_at: "2026-08-03T21:05:00Z",
      occurred_at: "2026-08-03T21:00:00Z",
      time_source: "stated",
    };
    const onDay = (rows: DerivedRow[], substance?: string) =>
      rows.filter(
        (r) => r.date === day && (substance ? r.substance === substance : true)
      );
    expect(onDay(substanceEventsByKey(db, 1), "nicotine")).toEqual([
      { ...stated, substance: "nicotine" },
      { ...derived, substance: "nicotine" },
      { ...derived, substance: "nicotine" },
    ]);
    expect(onDay(alcoholEvents(db, 1))).toEqual([stated, derived, derived]);
    // The decoys are still exactly what they were — nothing derived onto them, and the
    // neighbour profile gained nothing from this profile's counter.
    expect(substanceEvents(db, 2)).toHaveLength(1);
    expect(alcoholEvents(db, 2)).toHaveLength(1);
  });

  // REPLAY, PROVED BY RUNNING THE ARITHMETIC RATHER THAN BY WATCHING IT THROW (review
  // of #5290, finding F4). This used to call `up` a second time and assert nothing
  // changed — but `up` throws `duplicate column name: logged_via` at its ALTER, BEFORE
  // either backfill executes, so the "no-op" it observed was a statement that never
  // ran. The schema step is not replayable and does not need to be: the runner is
  // name-keyed. The BACKFILLS are the claim, so they are the seam, and they are called.
  //
  // Emptying one derived row first is what makes the run OBSERVABLE: a backfill that
  // executed and measured a shortfall tops the day back up to its counter, while one
  // that inserts the COUNT overshoots. Then a second call on a whole day adds nothing.
  it("re-running the backfills tops a shortfall back up and then adds nothing", () => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (10, 1, '2026-08-04', 'cannabis', 2, '2026-08-04T22:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (11, 1, '2026-08-04', 'alcohol', 2, '2026-08-04 20:00:00')`
    ).run();
    runMigrations(db, MIGRATIONS);
    expect(substanceEvents(db, 1)).toHaveLength(2);
    expect(alcoholEvents(db, 1)).toHaveLength(2);

    db.exec(
      `DELETE FROM substance_log_events WHERE id = (SELECT MIN(id) FROM substance_log_events);
       DELETE FROM food_log_events WHERE id = (SELECT MIN(id) FROM food_log_events)`
    );
    backfill(db);
    expect(substanceEvents(db, 1)).toHaveLength(2);
    expect(alcoholEvents(db, 1)).toHaveLength(2);

    backfill(db);
    expect(substanceEvents(db, 1)).toHaveLength(2);
    expect(alcoholEvents(db, 1)).toHaveLength(2);
  });

  // A FRACTIONAL COUNTER DERIVES WHOLE USES, AND NEVER ROUNDS ONE UP (review of
  // #5290). The recursive expansions stop at `remaining > 1`, so an unfloored 0.4 would
  // insert one event and 1.5 would insert two — a use in the record that the counter
  // and the weekly cap never held. Neither column stops a fraction reaching it:
  // `food_daily_totals.servings` is REAL, and `substance_daily_totals.units` is
  // declared INTEGER, which is an AFFINITY in SQLite and not a constraint — the
  // `toEqual({ units })` read before `runMigrations` below is what proves that rather
  // than assuming it.
  //
  // NO SHIPPED WRITER CAN PRODUCE THIS, said plainly: every production bump of either
  // counter is exactly 1, so against real data the floor is a no-op and this fixture is
  // the only thing that reaches the branch. It is here because the alternative to a
  // no-op is inventing a use.
  it.each([
    [0.4, 0],
    [1.5, 1],
    [2.5, 2],
    [3, 3],
  ])("derives whole uses from a counter reading %s", (units, expected) => {
    const db = beforeEvents();
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, recorded_at)
       VALUES (12, 1, '2026-08-06', 'nicotine', ?, '2026-08-06T10:00:00Z')`
    ).run(units);
    db.prepare(
      `INSERT INTO food_daily_totals
         (id, profile_id, date, group_key, servings, created_at)
       VALUES (13, 1, '2026-08-06', 'alcohol', ?, '2026-08-06 10:00:00')`
    ).run(units);
    // The fraction really is in both columns — INTEGER affinity did not round it.
    expect(
      db.prepare(`SELECT units FROM substance_daily_totals`).get()
    ).toEqual({ units });
    runMigrations(db, MIGRATIONS);
    expect(substanceEvents(db, 1)).toHaveLength(expected);
    expect(alcoholEvents(db, 1)).toHaveLength(expected);
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
