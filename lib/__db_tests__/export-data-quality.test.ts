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

  // A medication with full Rx identity + a supplement, so the supplements dataset
  // must distinguish them.
  medItemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, prescriber, pharmacy,
            rx_number, as_needed, critical, quantity_on_hand)
         VALUES (?, 'Lisinopril', 1, 'medication', 'daily', 'high', 'Dr. Ada Test',
                 'Test Pharmacy', 'RX-555-0142', 0, 1, 30)`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
     VALUES (?, 'Vitamin D', 1, 'supplement', 'daily', 'medium')`
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

describe("supplements dataset keeps medication identity (#466)", () => {
  it("carries kind + prescriber/pharmacy/rx/as_needed/critical/quantity", () => {
    const rows = getDataset("supplements")!.rows(profileId);
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
      expect(getDataset("supplements")!.columns).toContain(col);
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
