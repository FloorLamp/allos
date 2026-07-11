// DB INTEGRATION TIER — Withings response → rows → idempotent upserts.
//
// Drives the Withings pure mappers (mapWithingsMeasureGroup / mapWithingsSleep)
// through the SHARED normalize upserts against the real schema, proving what issue
// #142 requires: BP readings land as vitals like manually-entered BP, re-pushing the
// same window is all-unchanged (natural-key dedup), and a hand-edited imported row is
// left untouched (the #133 user-edit lock). Runs under vitest.db.config.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  mapWithingsMeasureGroup,
  mapWithingsSleep,
  WITHINGS_ID,
} from "@/lib/integrations/withings";
import {
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertVitals,
  type NormBodyMetric,
  type NormMetricSample,
  type NormVital,
} from "@/lib/integrations/normalize";

let profileId: number;

const TZ = "America/New_York";

// Two measure groups on the same local day: a scale weigh-in and a BP-cuff reading.
// The morning weigh-in carries weight + body fat + the scale's heart pulse (→ resting
// HR), so ONE (date, source) body-metrics row is written by the sync.
const WEIGH_IN = {
  grpid: 900001,
  date: 1700000000, // 2023-11-14 (EST)
  category: 1,
  timezone: TZ,
  measures: [
    { value: 70500, type: 1, unit: -3 }, // 70.5 kg
    { value: 185, type: 6, unit: -1 }, // 18.5 %
    { value: 61, type: 11, unit: 0 }, // 61 bpm heart pulse → resting HR
  ],
};
// The BP cuff carries only the two pressures → vitals (no body-metrics row).
const BP_READING = {
  grpid: 900002,
  date: 1700003600,
  category: 1,
  timezone: TZ,
  measures: [
    { value: 124, type: 10, unit: 0 }, // systolic
    { value: 80, type: 9, unit: 0 }, // diastolic
  ],
};
// Synthetic sleep-window unix timestamps (not identifiers of any kind).
const SLEEP_START = 1699929000; // phi-scan-ok: synthetic unix timestamp, not an NPI
const SLEEP_END = 1699957800; // phi-scan-ok: synthetic unix timestamp, not an NPI
const SLEEP = {
  id: 900003,
  timezone: TZ,
  startdate: SLEEP_START,
  enddate: SLEEP_END,
  date: "2023-11-14",
  data: {
    deepsleepduration: 4800,
    lightsleepduration: 13200,
    remsleepduration: 5400,
    wakeupduration: 1800,
  },
};

function batch(): {
  body: NormBodyMetric[];
  vitals: NormVital[];
  samples: NormMetricSample[];
} {
  const body: NormBodyMetric[] = [];
  const vitals: NormVital[] = [];
  const samples: NormMetricSample[] = [];
  for (const g of [WEIGH_IN, BP_READING]) {
    const m = mapWithingsMeasureGroup(g, TZ)!;
    if (m.bodyMetric) body.push(m.bodyMetric);
    vitals.push(...m.vitals);
  }
  const s = mapWithingsSleep(SLEEP, TZ)!;
  samples.push(...s.samples);
  return { body, vitals, samples };
}

function apply() {
  const b = batch();
  return db.transaction(() => ({
    body: upsertBodyMetrics(profileId, b.body, WITHINGS_ID),
    vitals: upsertVitals(profileId, b.vitals, WITHINGS_ID),
    samples: upsertMetricSamples(profileId, b.samples, WITHINGS_ID),
  }))();
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('WITHINGS-SYNC')").run()
      .lastInsertRowid
  );
});

describe("Withings sync upsert/dedup", () => {
  it("first push inserts everything; an identical re-push is all-unchanged", () => {
    const first = apply();
    // Two groups on the same day merge into ONE (date, source) body-metrics row.
    expect(first.body).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    // Systolic + diastolic = 2 vitals.
    expect(first.vitals.counts).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    // sleep_min + 4 stages = 5 samples.
    expect(first.samples).toEqual({ inserted: 5, updated: 0, unchanged: 0 });

    const second = apply();
    expect(second.body).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(second.vitals.counts).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(second.samples).toEqual({ inserted: 0, updated: 0, unchanged: 5 });
  });

  it("BP lands as vitals in medical_records like a manual reading", () => {
    apply();
    const sys = db
      .prepare(
        `SELECT category, value_num, unit, canonical_name, source, external_id
           FROM medical_records
          WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, "withings:900002:Blood Pressure Systolic") as {
      category: string;
      value_num: number;
      unit: string;
      canonical_name: string;
      source: string;
      external_id: string;
    };
    expect(sys.category).toBe("vitals");
    expect(sys.value_num).toBe(124);
    expect(sys.unit).toBe("mmHg");
    expect(sys.canonical_name).toBe("Blood Pressure Systolic");
    expect(sys.source).toBe("withings");
  });

  it("writes weight, body fat, and heart pulse to one body-metrics row", () => {
    apply();
    const bm = db
      .prepare(
        "SELECT weight_kg, body_fat_pct, resting_hr, source FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
      )
      .get(profileId, "2023-11-14", WITHINGS_ID) as {
      weight_kg: number;
      body_fat_pct: number;
      resting_hr: number;
      source: string;
    };
    expect(bm.weight_kg).toBe(70.5);
    expect(bm.body_fat_pct).toBe(18.5);
    expect(bm.resting_hr).toBe(61);
  });

  it("a hand-corrected imported weight is never clobbered by a re-push (#133)", () => {
    apply();
    db.prepare(
      "UPDATE body_metrics SET edited = 1, weight_kg = 71.2 WHERE profile_id = ? AND date = ? AND source IS ?"
    ).run(profileId, "2023-11-14", WITHINGS_ID);
    const res = apply();
    expect(res.body).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const bm = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
      )
      .get(profileId, "2023-11-14", WITHINGS_ID) as { weight_kg: number };
    expect(bm.weight_kg).toBe(71.2);
  });

  it("a hand-edited imported BP vital survives the next re-push", () => {
    apply();
    db.prepare(
      "UPDATE medical_records SET edited = 1, value_num = 130, value = '130' WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "withings:900002:Blood Pressure Systolic");
    const res = apply();
    expect(res.vitals.counts.unchanged).toBe(2);
    const sys = db
      .prepare(
        "SELECT value_num FROM medical_records WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "withings:900002:Blood Pressure Systolic") as {
      value_num: number;
    };
    expect(sys.value_num).toBe(130);
  });

  it("does not touch a manual body-metrics row for the same date (source-scoped)", () => {
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, '2023-11-14', 99, NULL)"
    ).run(profileId);
    apply();
    const manual = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS NULL"
      )
      .get(profileId, "2023-11-14") as { weight_kg: number };
    expect(manual.weight_kg).toBe(99);
  });

  it("a changed systolic reading flips that vital to updated, the other unchanged", () => {
    apply();
    // Clear any edit lock a prior test set on this row so the change isn't skipped.
    db.prepare(
      "UPDATE medical_records SET edited = 0 WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "withings:900002:Blood Pressure Systolic");
    const changed = {
      ...BP_READING,
      measures: [
        { value: 140, type: 10, unit: 0 }, // systolic changed
        { value: 80, type: 9, unit: 0 }, // diastolic same
        { value: 61, type: 11, unit: 0 },
      ],
    };
    const m = mapWithingsMeasureGroup(changed, TZ)!;
    const res = db.transaction(() =>
      upsertVitals(profileId, m.vitals, WITHINGS_ID)
    )();
    expect(res.counts.updated).toBe(1);
    expect(res.counts.unchanged).toBe(1);
  });
});
