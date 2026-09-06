// DB INTEGRATION TIER — 20260903-events-generalize-endurance-plans (#3285 item 1),
// and the proof of the issue's acceptance criterion 2: "existing endurance plans
// render byte-identically post-migration."
//
// THE CRITERION SPLITS IN TWO, AND ONLY ONE HALF IS ABOUT THE SCHEMA.
//
//   1. THE STORE. A pre-#3285 row must cross the table REBUILD with every value it
//      had — the rebuild is a create/copy/drop/rename, so a mistyped column in the
//      INSERT ... SELECT silently writes a NULL that no column-set assertion would
//      catch. Asserted below by reading `SELECT *` on both sides of `up()` and
//      comparing the WHOLE row object, so a column nobody thought to name still
//      fails the test.
//
//   2. THE RENDER. Every surface that names an event (the Overview badge and title,
//      Upcoming, the timeline row, the export CSV) now routes through helpers that
//      also serve events with no cardio pair. The oracle for "unchanged" therefore
//      cannot be those helpers — running them and asserting they agree with
//      themselves would pass on any rewrite. So the expected strings below are
//      LITERALS, written from the pre-#3285 rendering rules:
//        title    = event_name, else `${round1(km)} km ${Run|Ride|Swim}`
//        badge    = Run | Ride | Swim
//        upcoming = `Event: <title>` / `<Discipline> · <distance>`
//        timeline = `Event: <title>` / `<Discipline> · <km> km`
//      A literal cannot follow a refactor, which is the only reason it is worth
//      writing one out.
//
// SYNTHETIC ONLY: fictional events, low-entropy values, deep-past dates.

import Database from "better-sqlite3";
import { describe, expect, it, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { migration } from "@/lib/migrations/versions/20260903-events-generalize-endurance-plans";
import { migration as linkMigration } from "@/lib/migrations/versions/20260906-event-activity-link";
import { eventTitle, disciplineLabel } from "@/lib/endurance-plan";
import { getEndurancePlans } from "@/lib/endurance-plans";
import { enduranceEventItems } from "@/lib/queries/upcoming/plans";
import { getTimelineEvents } from "@/lib/timeline";
import { getDataset } from "@/lib/export";

const MIGRATION = "20260903-events-generalize-endurance-plans";

// ── 1. The store: the rebuild preserves every value ─────────────────────────────

// Three rows chosen for what they exercise, not for variety: a NAMED plan (the
// event_name path), an UNNAMED one (the derived-title path, the only place the
// cardio pair reaches a rendered string), and a COMPLETED one (completed_on +
// session_kinds + notes, the columns the copy is most likely to drop because no
// surface reads them).
function seedOldShape(): Database.Database {
  const mem = new Database(":memory:");
  runMigrations(mem, migrationsBefore(MIGRATION));
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Rebuild Test')")
    .run();
  const insert = mem.prepare(
    `INSERT INTO endurance_plans
       (id, profile_id, event_name, discipline, event_date, target_distance_km,
        target_time_sec, status, session_kinds, notes, completed_on, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    4,
    "City Half",
    "run",
    "2019-05-25",
    21.1,
    6300,
    "active",
    null,
    null,
    null,
    "2019-01-02 03:04:05"
  );
  insert.run(
    5,
    null,
    "ride",
    "2019-07-14",
    40,
    null,
    "active",
    null,
    null,
    null,
    "2019-01-03 03:04:05"
  );
  insert.run(
    6,
    "Lake Swim",
    "swim",
    "2019-03-09",
    1.5,
    null,
    "completed",
    '["tempo"]',
    "wetsuit legal",
    "2019-03-09",
    "2019-01-04 03:04:05"
  );
  return mem;
}

const allRows = (mem: Database.Database) =>
  mem.prepare("SELECT * FROM endurance_plans ORDER BY id").all() as Record<
    string,
    unknown
  >[];

describe("the rebuild preserves every stored value (#3285 acceptance criterion 2)", () => {
  it("carries each row across whole, adding only kind='race'", () => {
    const mem = seedOldShape();
    const before = allRows(mem);
    migration.up(mem);
    const after = allRows(mem);
    // Whole-object comparison: a column dropped from the INSERT ... SELECT fails
    // here even though nothing in this file names it.
    expect(after).toEqual(before.map((row) => ({ kind: "race", ...row })));
    mem.close();
  });

  it("keeps both indexes, and the one-active-per-discipline rule with them", () => {
    const mem = seedOldShape();
    migration.up(mem);
    const indexes = (
      mem
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'endurance_plans'
             AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toEqual([
      "idx_endurance_plans_active_discipline",
      "idx_endurance_plans_profile",
    ]);
    // A second ACTIVE run plan still collides.
    expect(() =>
      mem
        .prepare(
          `INSERT INTO endurance_plans (profile_id, kind, discipline, event_date, target_distance_km, status)
           VALUES (1, 'race', 'run', '2019-09-01', 10, 'active')`
        )
        .run()
    ).toThrow(/UNIQUE/);
    mem.close();
  });

  it("lets many active events with NO discipline coexist", () => {
    // SQLite treats NULLs as DISTINCT in a unique index, so the partial index that
    // caps cardio plans at one per discipline does not cap meets at one at all.
    // That is the behaviour the generalization needs and it is invisible in the DDL,
    // which is why it is pinned rather than assumed.
    const mem = seedOldShape();
    migration.up(mem);
    const insert = mem.prepare(
      `INSERT INTO endurance_plans (profile_id, kind, event_name, event_date, status)
       VALUES (1, ?, ?, ?, 'active')`
    );
    insert.run("meet", "County Meet", "2019-06-01");
    insert.run("tournament", "Club Open", "2019-06-08");
    insert.run("competition", "Winter Classic", "2019-06-15");
    expect(
      (
        mem
          .prepare(
            `SELECT COUNT(*) AS n FROM endurance_plans
              WHERE status = 'active' AND discipline IS NULL`
          )
          .get() as { n: number }
      ).n
    ).toBe(3);
    mem.close();
  });

  it("replays as a no-op on an already-converged database", () => {
    const mem = seedOldShape();
    migration.up(mem);
    const converged = allRows(mem);
    migration.up(mem);
    expect(allRows(mem)).toEqual(converged);
    mem.close();
  });
});

// ── 2. The render: the migrated rows still read exactly as they did ─────────────

// The rows above, as the migration leaves them, against the app's own reader stack.
const PROFILE = 1;
const TODAY = "2019-01-10";

beforeAll(() => {
  db.prepare("DELETE FROM endurance_plans").run();
  const insert = db.prepare(
    `INSERT INTO endurance_plans
       (id, profile_id, kind, event_name, discipline, event_date, target_distance_km,
        target_time_sec, status, created_at)
     VALUES (?, ?, 'race', ?, ?, ?, ?, ?, ?, '2019-01-02 03:04:05')`
  );
  insert.run(
    4,
    PROFILE,
    "City Half",
    "run",
    "2019-05-25",
    21.1,
    6300,
    "active"
  );
  insert.run(5, PROFILE, null, "ride", "2019-07-14", 40, null, "active");
});

describe("a migrated row renders byte-identically (#3285 acceptance criterion 2)", () => {
  it("titles and badges match the pre-#3285 strings", () => {
    const [named, unnamed] = getEndurancePlans(PROFILE).sort(
      (a, b) => a.id - b.id
    );
    // Literals, not re-derivations: the named plan keeps its name and the unnamed
    // one keeps the "<distance> km <Discipline>" fallback that WAS the only title
    // rule before an event could lack a discipline.
    expect(eventTitle(named)).toBe("City Half");
    expect(eventTitle(unnamed)).toBe("40 km Ride");
    expect(disciplineLabel(named.discipline!)).toBe("Run");
    expect(disciplineLabel(unnamed.discipline!)).toBe("Ride");
    // And both are still coached — the pair survived, so the trajectory arm still
    // sees them. (A row that lost its distance would title identically and quietly
    // stop being coached, which is the failure this line exists for.)
    expect(named.targetDistanceKm).toBe(21.1);
    expect(unnamed.targetDistanceKm).toBe(40);
    expect(named.kind).toBe("race");
  });

  it("the Upcoming event rows are unchanged", () => {
    const items = enduranceEventItems(PROFILE, TODAY).sort((a, b) =>
      a.key.localeCompare(b.key)
    );
    expect(items.map((i) => [i.key, i.title, i.detail])).toEqual([
      ["endurance-event:4", "Event: City Half", "Run · 21.1 km"],
      ["endurance-event:5", "Event: 40 km Ride", "Ride · 40 km"],
    ]);
  });

  it("the timeline rows are unchanged", () => {
    const rows = getTimelineEvents(PROFILE, { limit: 50 })
      .filter((e) => e.category === "endurance")
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((r) => [r.title, r.subtitle])).toEqual([
      ["Event: City Half", "Run · 21.1 km"],
      ["Event: 40 km Ride", "Ride · 40 km"],
    ]);
  });

  it("the export row carries every old column, with kind added", () => {
    const ds = getDataset("endurance_plans")!;
    // The declared columns ARE the CSV header and the data-manage table (#3285
    // acceptance criterion 4) — every pre-#3285 column is still declared, in order,
    // with `kind` leading.
    expect(ds.columns).toEqual([
      "kind",
      "event_name",
      "discipline",
      "event_date",
      "target_distance_km",
      "target_time_sec",
      "status",
      "notes",
      "completed_on",
      "created_at",
    ]);
    const row = ds.rows(PROFILE).find((r) => r.id === 4)!;
    for (const column of ds.columns) expect(row).toHaveProperty(column);
    expect(row.kind).toBe("race");
    expect(row.event_name).toBe("City Half");
    expect(row.target_distance_km).toBe(21.1);
  });
});

// ── 3. Item 2's migration, held to the same oracle ───────────────────────────────
//
// 20260906-event-activity-link adds `activities.endurance_plan_id`. An existing
// activity must cross it whole, gaining only a NULL link — the same whole-row compare
// as the rebuild above, so a column nobody names here still fails if it moves.

describe("20260906-event-activity-link leaves every activity as it was (#3285 item 2)", () => {
  function seedBeforeLink(): Database.Database {
    const mem = new Database(":memory:");
    runMigrations(mem, migrationsBefore(linkMigration.name));
    mem
      .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Link Test')")
      .run();
    mem
      .prepare(
        `INSERT INTO activities
           (id, profile_id, date, type, title, duration_min, distance_km, workout_type,
            source, external_id, notes, created_at)
         VALUES (7, 1, '2019-05-25', 'cardio', 'City Half', 105, 21.3, 'race',
                 'strava', 'strava:7', 'negative split', '2019-05-25 12:00:00')`
      )
      .run();
    return mem;
  }
  const rows = (mem: Database.Database) =>
    mem.prepare("SELECT * FROM activities ORDER BY id").all() as Record<
      string,
      unknown
    >[];

  it("adds only a NULL endurance_plan_id, keeps every other value, and replays as a no-op", () => {
    const mem = seedBeforeLink();
    const before = rows(mem);
    linkMigration.up(mem);
    const after = rows(mem);
    expect(after).toEqual(
      before.map((r) => ({ ...r, endurance_plan_id: null }))
    );
    linkMigration.up(mem);
    expect(rows(mem)).toEqual(after);
    expect(
      (
        mem.prepare("PRAGMA foreign_key_list(activities)").all() as {
          from: string;
          table: string;
          on_delete: string;
        }[]
      ).find((f) => f.from === "endurance_plan_id")
    ).toMatchObject({ table: "endurance_plans", on_delete: "SET NULL" });
    mem.close();
  });

  it("the activities export row carries every old column, with the link added last", () => {
    const ds = getDataset("activities")!;
    expect(ds.columns.at(-1)).toBe("endurance_plan_id");
    expect(ds.columns.slice(0, -1)).toEqual([
      "date",
      "type",
      "title",
      "exercises",
      "duration_min",
      "distance_km",
      "intensity",
      "start_time",
      "end_time",
      "avg_hr",
      "max_hr",
      "elevation_m",
      "avg_power_w",
      "avg_cadence",
      "kilojoules",
      "est_calories",
      "workout_type",
      "source",
      "external_id",
      "notes",
    ]);
  });
});
