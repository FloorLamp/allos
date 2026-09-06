// DB INTEGRATION TIER — export DATA QUALITY (issue #466).
//
// These domains ARE exported, but used to be exported wrongly or lossily: a skipped
// dose looked taken, a medication looked like an unlabeled supplement, and an
// activity's device telemetry + per-set strength numerics were flattened to prose.
// This seeds the exact shapes and asserts the corrected dataset columns/rows.

import { describe, it, expect, beforeAll } from "vitest";
import { getDataset, toCsv } from "@/lib/export";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

let profileId: number;
let medItemId: number;

beforeAll(() => {
  profileId = newProfile("DQ-EXPORT");

  // A medication with full Rx identity + a supplement, so the intake_items dataset
  // must distinguish them.
  medItemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, prescriber, pharmacy, rx_number, critical, quantity_on_hand)
         VALUES (?, 'Lisinopril', 1, 'medication', 'daily', 'should', 'Dr. Ada Test', 'Test Pharmacy', 'RX-555-0142', 1, 30)`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Vitamin D', 1, 'supplement', 'daily', 'should')`
  ).run(profileId);

  // One taken dose and one SKIPPED dose on the same medication.
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, sort)
         VALUES (?, '10 mg', 'morning', 0)`
      )
      .run(medItemId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
     VALUES (?, ?, '2024-05-01', 'taken', '10 mg')`
  ).run(doseId, medItemId);
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, skip_reason, amount)
     VALUES (?, ?, '2024-05-02', 'skipped', 'felt dizzy', '10 mg')`
  ).run(doseId, medItemId);

  // A strength activity carrying device telemetry and per-set numerics.
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, avg_hr, max_hr, elevation_m,
            avg_power_w, avg_cadence, kilojoules, est_calories, source, external_id)
         VALUES (?, '2024-05-03', 'strength', 'Push day', 45, 128, 165, 12, 210, 88,
                 900, 430, 'strava', 'strava:998877')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, target_reps, to_failure)
     VALUES (?, 'Bench Press', 1, 60, 8, 8, 0)`
  ).run(actId);
});

describe("intake_log distinguishes skipped from taken (#466)", () => {
  it("carries status, skip_reason and the amount snapshot", () => {
    const rows = getDataset("intake_log")!.rows(profileId);
    const skipped = rows.find((r) => r.status === "skipped")!;
    expect(skipped).toMatchObject({
      status: "skipped",
      skip_reason: "felt dizzy",
      amount: "10 mg",
    });
    const taken = rows.find((r) => r.status === "taken")!;
    expect(taken.status).toBe("taken");
    // The CSV header exposes the distinguishing columns.
    const ds = getDataset("intake_log")!;
    expect(ds.columns).toContain("status");
    expect(ds.columns).toContain("skip_reason");
    expect(ds.columns).toContain("amount");
    expect(toCsv(ds.columns, rows).split("\n")[0]).toBe(ds.columns.join(","));
  });
});

describe("intake_items dataset keeps medication identity (#466)", () => {
  it("carries kind + prescriber/pharmacy/rx/obligation/critical/quantity", () => {
    const rows = getDataset("intake_items")!.rows(profileId);
    const med = rows.find((r) => r.name === "Lisinopril")!;
    expect(med).toMatchObject({
      kind: "medication",
      prescriber: "Dr. Ada Test",
      pharmacy: "Test Pharmacy",
      rx_number: "RX-555-0142",
      critical: 1,
      quantity_on_hand: 30,
    });
    const supp = rows.find((r) => r.name === "Vitamin D")!;
    expect(supp.kind).toBe("supplement");
    for (const col of ["kind", "prescriber", "pharmacy", "rx_number"])
      expect(getDataset("intake_items")!.columns).toContain(col);
  });
});

describe("activities keep telemetry; exercise_sets keep numerics (#466)", () => {
  it("activities row carries device telemetry, not just the prose summary", () => {
    const act = getDataset("activities")!
      .rows(profileId)
      .find((r) => r.title === "Push day")!;
    expect(act).toMatchObject({
      avg_hr: 128,
      max_hr: 165,
      elevation_m: 12,
      avg_power_w: 210,
      avg_cadence: 88,
      kilojoules: 900,
      est_calories: 430,
      source: "strava",
      external_id: "strava:998877",
    });
    // The human summary is still present alongside the raw telemetry.
    expect(String(act.exercises)).toContain("Bench Press");
  });

  it("exercise_sets dataset exposes per-set weight/reps/target", () => {
    const sets = getDataset("exercise_sets")!.rows(profileId);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      exercise: "Bench Press",
      set_number: 1,
      weight_kg: 60,
      reps: 8,
      target_reps: 8,
    });
    // Child dataset: browse/export-only.
    expect(getDataset("exercise_sets")!.deletable).toBe(false);
  });
});

describe("body_metrics / medical_records carry provenance (#466)", () => {
  it("both datasets expose source + edited (records also document_id)", () => {
    const bm = getDataset("body_metrics")!.columns;
    expect(bm).toContain("source");
    expect(bm).toContain("edited");
    const mr = getDataset("medical_records")!.columns;
    expect(mr).toContain("source");
    expect(mr).toContain("edited");
    expect(mr).toContain("document_id");
  });
});

// An activity that was an event's result (#3285 item 2). The link is stored as the
// Events row's id, and an id is the one thing this export never publishes — no
// dataset emits one, the Events dataset included — so a raw `endurance_plan_id` cell
// would be an internal number pointing at a CSV that prints no such number. The
// activities row carries the pair the Events dataset DOES publish instead, and this
// asserts the join by doing it: the pair off the activities CSV finds the event's own
// row in the events CSV. All the seeded values are comma-free, so a plain split reads
// both files back.
describe("an activity's event link exports as the event's identity (#3285 item 2)", () => {
  function parse(csv: string): Record<string, string>[] {
    const [header, ...lines] = csv.trim().split("\n");
    const cols = header.split(",");
    return lines.map((l) =>
      Object.fromEntries(l.split(",").map((v, i) => [cols[i], v]))
    );
  }

  it("names the event by the pair the Events dataset publishes, not by its row id", () => {
    const p = newProfile("EXPORT-EVENT-LINK");
    const planId = Number(
      db
        .prepare(
          `INSERT INTO endurance_plans
             (profile_id, kind, event_name, discipline, event_date, target_distance_km, status)
           VALUES (?, 'race', 'Harbor 10k', 'run', '2026-06-14', 10, 'active')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, distance_km, endurance_plan_id)
       VALUES (?, '2026-06-14', 'cardio', 'Race morning', 10.1, ?)`
    ).run(p, planId);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, distance_km)
       VALUES (?, '2026-06-13', 'cardio', 'Shakeout', 3)`
    ).run(p);
    // A result the event kept when one of the two dates moved afterwards: the cell
    // names the EVENT's day, which is the day the events CSV prints, not the day the
    // session was logged on.
    const movedPlan = Number(
      db
        .prepare(
          `INSERT INTO endurance_plans
             (profile_id, kind, event_name, discipline, event_date, target_distance_km, status)
           VALUES (?, 'race', 'Lakeside Gran Fondo', 'ride', '2026-09-20', 100, 'active')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, distance_km, endurance_plan_id)
       VALUES (?, '2026-09-19', 'cardio', 'Fondo morning', 101, ?)`
    ).run(p, movedPlan);

    const acts = getDataset("activities")!;
    const events = getDataset("endurance_plans")!;
    // The id is not in either file, in either direction.
    expect(acts.columns).not.toContain("endurance_plan_id");
    expect(events.columns).not.toContain("id");
    expect(acts.columns).toContain("event_name");
    expect(acts.columns).toContain("event_date");

    const activityRows = parse(toCsv(acts.columns, acts.rows(p)));
    const eventRows = parse(toCsv(events.columns, events.rows(p)));
    const result = activityRows.find((r) => r.title === "Race morning")!;
    expect([result.event_name, result.event_date]).toEqual([
      "Harbor 10k",
      "2026-06-14",
    ]);
    // A session that was nobody's result says so with two empty cells.
    const free = activityRows.find((r) => r.title === "Shakeout")!;
    expect([free.event_name, free.event_date]).toEqual(["", ""]);

    const moved = activityRows.find((r) => r.title === "Fondo morning")!;
    expect([moved.date, moved.event_name, moved.event_date]).toEqual([
      "2026-09-19",
      "Lakeside Gran Fondo",
      "2026-09-20",
    ]);

    // The join, done: the pair off the activities CSV finds the event's row.
    const matched = eventRows.filter(
      (e) =>
        e.event_name === result.event_name && e.event_date === result.event_date
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ kind: "race", discipline: "run" });
  });

  // The join is profile-scoped, which no writer in the app can exercise: both link
  // cores refuse a cross-profile pair, a merge stays inside one profile, and a
  // restore nulls a link whose event is gone. So the state is PLANTED here by hand —
  // an unpinned scoping clause is how the next refactor drops one (#5430 review).
  it("never names another profile's event, even on a link no writer could make", () => {
    const mine = newProfile("EXPORT-EVENT-LINK-MINE");
    const theirs = newProfile("EXPORT-EVENT-LINK-THEIRS");
    const theirPlan = Number(
      db
        .prepare(
          `INSERT INTO endurance_plans
             (profile_id, kind, event_name, discipline, event_date, target_distance_km, status)
           VALUES (?, 'race', 'Their Marathon', 'run', '2026-07-04', 42.2, 'active')`
        )
        .run(theirs).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, endurance_plan_id)
       VALUES (?, '2026-07-04', 'cardio', 'Long run', ?)`
    ).run(mine, theirPlan);

    const row = getDataset("activities")!
      .rows(mine)
      .find((r) => r.title === "Long run")!;
    expect([row.event_name, row.event_date]).toEqual([null, null]);
  });
});
