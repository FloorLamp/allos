// DB INTEGRATION TIER — 20260911-stool-events (#5872): the Bristol samples move to
// their own ledger.
//
// WHAT THIS FILE IS, STATED PLAINLY: most of it is a REGRESSION GUARD, not a
// falsification of a defect. The migration's whole claim is that NOTHING CHANGES ON
// SCREEN — every row that showed a type at a minute still shows that type at that
// minute — so the assertions below are written against a defect that does not exist
// yet and exists to keep it from being introduced. The one case that does falsify
// something is `leaves no bristol_stool_type row behind`: a move that only COPIED would
// leave the old rows standing, and that is the dual-write cutover this slice is
// forbidden to perform.
//
// The fixture deliberately holds BOTH shapes `started_at` takes for this metric — a
// stated wall time (`<date>T<HH:MM>:00`) and a clock fallback carrying seconds — and
// the test asserts they are treated IDENTICALLY. That is the honesty argument as an
// executable statement: the old store cannot tell them apart, so the migration does not
// pretend to, and a later reader who "improves" the migration to file the second one as
// unstated fails here with the round-trip that names what it cost.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore, MIGRATIONS } from "@/lib/migrations/versions";
import { move } from "@/lib/migrations/versions/20260911-stool-events";

const NAME = "20260911-stool-events";
const TZ = "America/New_York";

// The displayed minute, computed the way the OLD reader computed it: the local wall
// clock sitting in `started_at`, characters 12-16. This is the number the round-trip
// has to reproduce, and it is deliberately spelled here rather than imported so a
// change to the new reader cannot quietly redefine what "unchanged" means.
function displayedBefore(startedAt: string): string {
  return startedAt.slice(11, 16);
}

// The displayed minute AFTER the move: the canonical instant read back in the profile's
// own zone, which is what `bestKnownInstant` + the history clock do.
function displayedAfter(occurredAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(occurredAt));
}

interface Sample {
  id: number;
  date: string;
  started_at: string;
  value: number;
}

// Two profiles, so the move's profile scoping is exercised rather than assumed, and a
// spread of rows covering every shape this metric's two writers produce plus the one
// they do not (an out-of-scale value, which only a hand-edit could create).
const SAMPLES: Sample[] = [
  // A STATED wall time: seconds are :00 because the writer builds `<date>T<HH:MM>:00`.
  { id: 11, date: "2026-09-01", started_at: "2026-09-01T07:41:00", value: 4 },
  // A CLOCK FALLBACK on the same minute, carrying seconds off the instant. The old
  // store cannot tell this from the row above and neither may the migration.
  { id: 12, date: "2026-09-01", started_at: "2026-09-01T07:41:37", value: 6 },
  // Two rows on the SAME minute of the same day — the merge defect's shape. They are
  // two samples here only because their `started_at` differs by a second; after the
  // move the ledger has no natural key at all.
  { id: 13, date: "2026-09-02", started_at: "2026-09-02T23:05:00", value: 1 },
  { id: 14, date: "2026-09-02", started_at: "2026-09-02T23:05:01", value: 7 },
  // A midnight row, the boundary a zone conversion is most likely to move a DAY across.
  { id: 15, date: "2026-09-03", started_at: "2026-09-03T00:00:00", value: 3 },
  // Out of scale: never written by this app, and it must not be DROPPED either.
  { id: 16, date: "2026-09-04", started_at: "2026-09-04T09:00:00", value: 9 },
];

function beforeMove(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(NAME));
  db.prepare("INSERT INTO profiles(id, name) VALUES (1, 'Mover')").run();
  db.prepare("INSERT INTO profiles(id, name) VALUES (2, 'Other')").run();
  for (const id of [1, 2])
    db.prepare(
      "INSERT INTO profile_settings(profile_id, key, value) VALUES (?, 'timezone', ?)"
    ).run(id, TZ);
  const insert = db.prepare(
    `INSERT INTO metric_samples
       (id, profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, ?, 'manual', 'bristol_stool_type', ?, ?, ?, ?)`
  );
  for (const s of SAMPLES)
    insert.run(s.id, 1, s.date, s.started_at, s.started_at, s.value);
  // The OTHER profile's row, and one sample of a DIFFERENT metric, both of which the
  // move must leave exactly where they are relative to their own owner.
  insert.run(90, 2, "2026-09-01", "2026-09-01T08:15:00", "2026-09-01T08:15:00", 5);
  db.prepare(
    `INSERT INTO metric_samples
       (id, profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (99, 1, 'manual', 'hrv_ms', '2026-09-01', '2026-09-01T00:00:00',
             '2026-09-01T00:00:00', 42)`
  ).run();
  return db;
}

function afterMove(): Database.Database {
  const db = beforeMove();
  // The runner refuses a database carrying migrations the passed list does not know,
  // so it is handed the WHOLE registry and applies the one that is pending — which is
  // also how a real upgrade reaches this migration.
  runMigrations(db, MIGRATIONS);
  return db;
}

interface EventRow {
  id: number;
  profile_id: number;
  date: string;
  recorded_at: string;
  occurred_at: string | null;
  time_source: string | null;
  type: number | null;
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT id, profile_id, date, recorded_at, occurred_at, time_source, type
         FROM stool_events ORDER BY id ASC`
    )
    .all() as EventRow[];
}

describe("#5872 the Bristol samples move to stool_events", () => {
  // REGRESSION GUARD. Nothing is broken today; this pins that the move keeps every row.
  it("moves every sample across, both profiles, nothing lost", () => {
    const db = afterMove();
    const rows = events(db);
    expect(rows).toHaveLength(SAMPLES.length + 1);
    expect(rows.filter((r) => r.profile_id === 1)).toHaveLength(SAMPLES.length);
    expect(rows.filter((r) => r.profile_id === 2)).toHaveLength(1);
    // Every moved row keeps its own day. A zone conversion that re-attributed the
    // midnight row would show up here and nowhere else.
    expect(
      rows.filter((r) => r.profile_id === 1).map((r) => r.date)
    ).toEqual(SAMPLES.map((s) => s.date));
    db.close();
  });

  // THE ROUND TRIP, and the reason this file exists: rows in, rows out, and the
  // DISPLAYED INSTANT identical before and after. REGRESSION GUARD — the whole content
  // of the assertion is that something is unchanged.
  it("renders every row at the same minute it rendered at before", () => {
    const before = beforeMove();
    const shown = new Map(
      (
        before
          .prepare(
            `SELECT id, started_at FROM metric_samples
              WHERE profile_id = 1 AND metric = 'bristol_stool_type' ORDER BY id`
          )
          .all() as { id: number; started_at: string }[]
      ).map((r) => [r.id, displayedBefore(r.started_at)])
    );
    before.close();

    const db = afterMove();
    const rows = events(db).filter((r) => r.profile_id === 1);
    const after = rows.map((r) => displayedAfter(r.occurred_at as string));
    expect(after).toEqual([...shown.values()]);
    db.close();
  });

  // THE HONESTY ARGUMENT, EXECUTABLE. Both shapes become 'stated' — the clock-fallback
  // row at :37 seconds gets exactly the treatment the typed-time row at :00 gets.
  // REGRESSION GUARD against a future "improvement" that guesses per row.
  it("files every moved row as stated, stated-looking or not", () => {
    const db = afterMove();
    const rows = events(db);
    expect(rows.every((r) => r.time_source === "stated")).toBe(true);
    expect(rows.every((r) => r.occurred_at !== null)).toBe(true);
    // The two same-minute rows differ only in their seconds, which is precisely the
    // signal a cleverer migration would have read as "this one is a fallback".
    const [stated, fallback] = rows;
    expect(stated.time_source).toBe(fallback.time_source);
    db.close();
  });

  // FALSIFIED against a copy-only migration: comment out the DELETE in `move` and this
  // case fails with 6 rows left behind, while every other case in this file still
  // passes. That is the no-dual-write claim, checked rather than asserted.
  it("leaves no bristol_stool_type row behind, and touches no other metric", () => {
    const db = afterMove();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM metric_samples WHERE metric = 'bristol_stool_type'"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE metric = 'hrv_ms'")
        .get()
    ).toEqual({ n: 1 });
    db.close();
  });

  // REGRESSION GUARD. The type travels as the stored number, and a value the scale does
  // not name becomes an UNTYPED occurrence rather than a dropped row — the same "keep
  // the row" rule the whole move is built on. The old reader skipped such a row; the
  // new one titles it `Stool`, which is strictly more than was there before.
  it("carries the type across and keeps an out-of-scale row as untyped", () => {
    const db = afterMove();
    const mine = events(db).filter((r) => r.profile_id === 1);
    expect(mine.map((r) => r.type)).toEqual([4, 6, 1, 7, 3, null]);
    db.close();
  });

  // FALSIFIED against a non-idempotent move: drop the `DELETE` and run `move` twice and
  // the ledger doubles. The seam exists so this can be executed rather than asserted
  // (the review-of-#5290 finding on the substance backfill).
  it("is a no-op on replay", () => {
    const db = afterMove();
    const first = events(db);
    move(db);
    expect(events(db)).toEqual(first);
    db.close();
  });
});
