// DB INTEGRATION TIER — real insert/update/unchanged accounting.
//
// The correctness proof for the SELECT-before-compare upserts: better-sqlite3's
// `info.changes` counts a MATCHED row even when no value differed, so "unchanged"
// is only detectable by reading the pre-image and comparing it to the resolved
// post-image. For each of the five upserts we assert the same batch, run twice, is
// all-inserted then all-unchanged, and that mutating one field flips it to updated.
// Runs against a real (in-memory / temp-file) schema via vitest.db.config.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertHrMinutes,
  upsertVitals,
  type NormActivity,
  type NormBodyMetric,
  type NormMetricSample,
  type NormHrMinute,
  type NormVital,
} from "@/lib/integrations/normalize";
import { emptyCounts } from "@/lib/integrations/sync-log";

const SOURCE = "health-connect";
let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('DIFF-ACCT')").run()
      .lastInsertRowid
  );
});

describe("upsert accounting: inserted → unchanged → updated", () => {
  it("upsertActivities", () => {
    const rows: NormActivity[] = [
      {
        external_id: "hc:act:1",
        date: "2024-05-01",
        type: "cardio" as const,
        title: "Morning run",
        duration_min: 30,
        distance_km: 5,
        start_time: "07:00",
        end_time: "07:30",
        avg_hr: 140,
      },
    ];
    expect(upsertActivities(profileId, rows, SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    // Identical re-ingest → unchanged (a no-op that info.changes would mis-report).
    expect(upsertActivities(profileId, rows, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    // Mutate one field → updated.
    const changed = [{ ...rows[0], title: "Evening run" }];
    expect(upsertActivities(profileId, changed, SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    // And a metric-only change (avg_hr) is also an update.
    const metricChanged = [{ ...changed[0], avg_hr: 150 }];
    expect(upsertActivities(profileId, metricChanged, SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
  });

  it("upsertActivities counts a hand-edited row as unchanged (left untouched)", () => {
    const rows: NormActivity[] = [
      {
        external_id: "hc:act:edited",
        date: "2024-05-02",
        type: "cardio" as const,
        title: "Ride",
        duration_min: 60,
        distance_km: 20,
        start_time: null,
        end_time: null,
      },
    ];
    expect(upsertActivities(profileId, rows, SOURCE).inserted).toBe(1);
    // Simulate the user hand-editing the imported row.
    db.prepare(
      "UPDATE activities SET edited = 1, title = 'My edited ride' WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "hc:act:edited");
    // Re-ingest with a DIFFERENT title must NOT clobber the edit and is unchanged.
    const changed = [{ ...rows[0], title: "Ride (auto)" }];
    expect(upsertActivities(profileId, changed, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    const stored = db
      .prepare(
        "SELECT title FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "hc:act:edited") as { title: string };
    expect(stored.title).toBe("My edited ride");
  });

  it("upsertActivities never clobbers a hand-set activity equipment link (#342)", () => {
    const bikeId = Number(
      db
        .prepare(
          "INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Sync Bike', 'Bike')"
        )
        .run(profileId).lastInsertRowid
    );
    const rows: NormActivity[] = [
      {
        external_id: "hc:act:gear",
        date: "2024-06-01",
        type: "cardio" as const,
        title: "Ride",
        duration_min: 40,
        distance_km: 12,
        start_time: null,
        end_time: null,
      },
    ];
    expect(upsertActivities(profileId, rows, SOURCE).inserted).toBe(1);
    // The user links gear via the app but does NOT otherwise edit the row — proving
    // equipment_id is outside the sync footprint even on the live UPDATE path (not
    // just protected by the edited lock).
    db.prepare(
      "UPDATE activities SET equipment_id = ? WHERE profile_id = ? AND external_id = ?"
    ).run(bikeId, profileId, "hc:act:gear");
    // A genuine metric change forces the UPDATE branch; it must leave equipment_id.
    const changed = [{ ...rows[0], distance_km: 13 }];
    expect(upsertActivities(profileId, changed, SOURCE).updated).toBe(1);
    const stored = db
      .prepare(
        "SELECT equipment_id, distance_km FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "hc:act:gear") as {
      equipment_id: number | null;
      distance_km: number;
    };
    expect(stored.equipment_id).toBe(bikeId); // gear survived the re-sync UPDATE
    expect(stored.distance_km).toBe(13); // the metric change did apply
  });

  it("upsertBodyMetrics", () => {
    const rows: NormBodyMetric[] = [
      { date: "2024-05-03", weight_kg: 80, body_fat_pct: 18, resting_hr: 55 },
    ];
    expect(upsertBodyMetrics(profileId, rows, SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(upsertBodyMetrics(profileId, rows, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    const changed = [{ ...rows[0], weight_kg: 79.5 }];
    expect(upsertBodyMetrics(profileId, changed, SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    // A window carrying only an already-stored subset is still unchanged (merge
    // fills no gap and overwrites nothing).
    const subset = [{ date: "2024-05-03", resting_hr: 55 }];
    expect(upsertBodyMetrics(profileId, subset, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
  });

  it("upsertBodyMetrics counts a hand-edited row as unchanged (edit survives)", () => {
    const rows: NormBodyMetric[] = [
      { date: "2024-05-13", weight_kg: 82, body_fat_pct: 20, resting_hr: 60 },
    ];
    expect(upsertBodyMetrics(profileId, rows, SOURCE).inserted).toBe(1);
    // Simulate the user hand-correcting the imported weight (Review resolver sets
    // the edit lock on a source-owned keeper).
    db.prepare(
      "UPDATE body_metrics SET edited = 1, weight_kg = 79 WHERE profile_id = ? AND date = ? AND source IS ?"
    ).run(profileId, "2024-05-13", SOURCE);
    // Re-ingest the same window with the ORIGINAL (wrong) weight must NOT clobber
    // the correction and is counted unchanged.
    expect(upsertBodyMetrics(profileId, rows, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    const stored = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
      )
      .get(profileId, "2024-05-13", SOURCE) as { weight_kg: number };
    expect(stored.weight_kg).toBe(79);
  });

  it("upsertVitals leaves a hand-edited imported vital untouched (unchanged, id not re-touched)", () => {
    const rows: NormVital[] = [
      {
        external_id: "hc:vital:edited",
        date: "2024-05-14",
        category: "vitals" as const,
        name: "Systolic blood pressure",
        canonical: "systolic_bp",
        value_num: 130,
        unit: "mmHg",
      },
    ];
    const first = upsertVitals(profileId, rows, SOURCE);
    expect(first.counts.inserted).toBe(1);
    // Simulate the medical editor locking the imported row on a hand-edit.
    db.prepare(
      "UPDATE medical_records SET edited = 1, value = '125', value_num = 125 WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "hc:vital:edited");
    // Re-ingest with the original value → unchanged, edit preserved, id NOT returned
    // (the locked row is left entirely untouched — no flag re-derivation).
    const second = upsertVitals(profileId, rows, SOURCE);
    expect(second.counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(second.ids).toEqual([]);
    const stored = db
      .prepare(
        "SELECT value_num FROM medical_records WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "hc:vital:edited") as { value_num: number };
    expect(stored.value_num).toBe(125);
  });

  it("upsertMetricSamples", () => {
    const rows: NormMetricSample[] = [
      {
        metric: "steps",
        date: "2024-05-04",
        start_time: "2024-05-04T00:00",
        end_time: "2024-05-04T23:59",
        value: 8000,
      },
    ];
    expect(upsertMetricSamples(profileId, rows, SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(upsertMetricSamples(profileId, rows, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    const changed = [{ ...rows[0], value: 8500 }];
    expect(upsertMetricSamples(profileId, changed, SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
  });

  it("upsertHrMinutes", () => {
    const rows: NormHrMinute[] = [
      { ts: "2024-05-05T08:00", bpm: 70, bpm_min: 65, bpm_max: 80, n: 6 },
    ];
    expect(upsertHrMinutes(profileId, rows, SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(upsertHrMinutes(profileId, rows, SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    const changed = [{ ...rows[0], bpm: 72 }];
    expect(upsertHrMinutes(profileId, changed, SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
  });

  it("upsertVitals (returns ids + counts)", () => {
    const rows: NormVital[] = [
      {
        external_id: "hc:vital:1",
        date: "2024-05-06",
        category: "vitals" as const,
        name: "Systolic blood pressure",
        canonical: "systolic_bp",
        value_num: 120,
        unit: "mmHg",
      },
    ];
    const first = upsertVitals(profileId, rows, SOURCE);
    expect(first.counts).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(first.ids).toHaveLength(1);

    const second = upsertVitals(profileId, rows, SOURCE);
    expect(second.counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    // The row id is still returned on an unchanged pass (reconcileFlags needs it).
    expect(second.ids).toEqual(first.ids);

    const changed = [{ ...rows[0], value_num: 118 }];
    const third = upsertVitals(profileId, changed, SOURCE);
    expect(third.counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(third.ids).toEqual(first.ids);
  });

  it("folds cleanly from an empty baseline", () => {
    // Sanity: empty input yields the zero baseline for every upsert.
    expect(upsertActivities(profileId, [], SOURCE)).toEqual(emptyCounts());
    expect(upsertBodyMetrics(profileId, [], SOURCE)).toEqual(emptyCounts());
    expect(upsertMetricSamples(profileId, [], SOURCE)).toEqual(emptyCounts());
    expect(upsertHrMinutes(profileId, [], SOURCE)).toEqual(emptyCounts());
    expect(upsertVitals(profileId, [], SOURCE).counts).toEqual(emptyCounts());
  });
});
