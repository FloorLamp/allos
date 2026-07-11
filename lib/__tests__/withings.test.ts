import { describe, it, expect } from "vitest";
import {
  mapWithingsMeasureGroup,
  mapWithingsSleep,
  localFromUnix,
  WITHINGS_ID,
} from "@/lib/integrations/withings";

// Synthetic Withings API fixtures — shapes/units mirror the real API
// (https://developer.withings.com/api-reference) with obviously-fake ids/values.
// Withings encodes a quantity as value × 10^unit; measurements are grouped
// (measuregrp) and carry a unix `date` + IANA `timezone`.

const TZ = "America/New_York";
// 1700000000 = 2023-11-14T22:13:20Z → 17:13 in America/New_York (EST, same day).
const NOV14_UNIX = 1700000000;
// Synthetic sleep-window unix timestamps (not identifiers of any kind).
const SLEEP_START = 1699929000; // phi-scan-ok: synthetic unix timestamp, not an NPI
const SLEEP_END = 1699957800; // phi-scan-ok: synthetic unix timestamp, not an NPI

function measureGroup(over: Record<string, unknown> = {}) {
  return {
    grpid: 100001,
    date: NOV14_UNIX,
    category: 1,
    timezone: TZ,
    measures: [
      { value: 70500, type: 1, unit: -3 }, // 70.5 kg
      { value: 185, type: 6, unit: -1 }, // 18.5 %
      { value: 62, type: 11, unit: 0 }, // 62 bpm heart pulse
    ],
    ...over,
  };
}

describe("localFromUnix", () => {
  it("attributes an instant to the local day/HH:MM of the given timezone", () => {
    const loc = localFromUnix(NOV14_UNIX, TZ);
    expect(loc).not.toBeNull();
    expect(loc!.date).toBe("2023-11-14");
    expect(loc!.hhmm).toBe("17:13");
    expect(loc!.iso).toBe("2023-11-14T22:13:20.000Z");
  });

  it("rejects a garbage / year-3000 timestamp (#132) as null", () => {
    expect(localFromUnix(NaN, TZ)).toBeNull();
    expect(localFromUnix(99999999999, TZ)).toBeNull(); // year ~5138
    expect(localFromUnix(null, TZ)).toBeNull();
  });
});

describe("mapWithingsMeasureGroup", () => {
  it("maps weight/fat/pulse to one body-metrics row in canonical units", () => {
    const res = mapWithingsMeasureGroup(measureGroup(), "UTC");
    expect(res).not.toBeNull();
    expect(res!.bodyMetric).toEqual({
      date: "2023-11-14",
      weight_kg: 70.5,
      body_fat_pct: 18.5,
      resting_hr: 62,
    });
    expect(res!.vitals).toEqual([]);
  });

  it("prefers the per-group timezone over the batch default", () => {
    // Same instant, a UTC group → the local day is still the 14th at 22:13 UTC.
    const res = mapWithingsMeasureGroup(
      measureGroup({ timezone: "UTC" }),
      "America/Los_Angeles"
    );
    expect(res!.bodyMetric!.date).toBe("2023-11-14");
  });

  it("maps blood pressure to two distinct per-analyte vitals", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        grpid: 100002,
        measures: [
          { value: 122, type: 10, unit: 0 }, // systolic
          { value: 79, type: 9, unit: 0 }, // diastolic
          { value: 68, type: 11, unit: 0 }, // pulse
        ],
      }),
      "UTC"
    );
    const byName = Object.fromEntries(res!.vitals.map((v) => [v.canonical, v]));
    expect(byName["Blood Pressure Systolic"]).toMatchObject({
      external_id: `${WITHINGS_ID}:100002:Blood Pressure Systolic`,
      category: "vitals",
      value_num: 122,
      unit: "mmHg",
      date: "2023-11-14",
    });
    expect(byName["Blood Pressure Diastolic"]).toMatchObject({
      external_id: `${WITHINGS_ID}:100002:Blood Pressure Diastolic`,
      value_num: 79,
      unit: "mmHg",
    });
    // The pulse from a BP cuff still lands as resting HR.
    expect(res!.bodyMetric).toEqual({ date: "2023-11-14", resting_hr: 68 });
  });

  it("maps SpO2 and converts body temperature °C → °F canonical", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        grpid: 100003,
        measures: [
          { value: 97, type: 54, unit: 0 }, // SpO2 97 %
          { value: 370, type: 71, unit: -1 }, // 37.0 °C → 98.6 °F
        ],
      }),
      "UTC"
    );
    const byName = Object.fromEntries(res!.vitals.map((v) => [v.canonical, v]));
    expect(byName["Oxygen Saturation"]).toMatchObject({
      value_num: 97,
      unit: "%",
    });
    expect(byName["Body Temperature"]).toMatchObject({
      value_num: 98.6,
      unit: "degF",
    });
  });

  it("drops a physiologically-impossible value (#132) but keeps the rest", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        measures: [
          { value: 5000000, type: 1, unit: -3 }, // 5000 kg — impossible
          { value: 62, type: 11, unit: 0 }, // valid pulse
        ],
      }),
      "UTC"
    );
    // Weight rejected, pulse kept.
    expect(res!.bodyMetric).toEqual({ date: "2023-11-14", resting_hr: 62 });
  });

  it("returns null when the group has no id or an unusable timestamp", () => {
    expect(
      mapWithingsMeasureGroup(measureGroup({ grpid: null }), "UTC")
    ).toBeNull();
    expect(
      mapWithingsMeasureGroup(measureGroup({ date: 99999999999 }), "UTC")
    ).toBeNull();
    expect(mapWithingsMeasureGroup(null, "UTC")).toBeNull();
  });

  it("returns null when a group carries no mappable measures", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({ measures: [{ value: 175, type: 4, unit: -2 }] }), // height only
      "UTC"
    );
    expect(res).toBeNull();
  });

  it("maps body-composition types to point samples keyed on the group instant (#419)", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        grpid: 100004,
        measures: [
          { value: 70500, type: 1, unit: -3 }, // 70.5 kg weight
          { value: 55000, type: 5, unit: -3 }, // 55.0 kg lean (fat-free) mass
          { value: 52000, type: 76, unit: -3 }, // 52.0 kg muscle mass
          { value: 3200, type: 88, unit: -3 }, // 3.2 kg bone mass
          { value: 40000, type: 77, unit: -3 }, // 40.0 kg total body water
        ],
      }),
      "UTC"
    );
    const byMetric = Object.fromEntries(
      res!.samples.map((s) => [s.metric, s.value])
    );
    expect(byMetric).toEqual({
      lean_mass_kg: 55,
      muscle_mass_kg: 52,
      bone_mass_kg: 3.2,
      body_water_kg: 40,
    });
    // Point samples: start == end == the group's instant (the dedup key).
    for (const s of res!.samples) {
      expect(s.date).toBe("2023-11-14");
      expect(s.start_time).toBe("2023-11-14T22:13:20.000Z");
      expect(s.end_time).toBe(s.start_time);
    }
    // Weight still lands in body_metrics; composition never touches it.
    expect(res!.bodyMetric).toMatchObject({ weight_kg: 70.5 });
  });

  it("maps VO2 max to the biomarker vital (#419)", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        grpid: 100005,
        measures: [{ value: 48, type: 123, unit: 0 }], // 48 mL/kg/min
      }),
      "UTC"
    );
    const vo2 = res!.vitals.find((v) => v.canonical === "VO2 Max");
    expect(vo2).toMatchObject({
      external_id: `${WITHINGS_ID}:100005:VO2 Max`,
      category: "biomarker",
      value_num: 48,
      unit: "mL/kg/min",
      date: "2023-11-14",
    });
  });

  it("drops an out-of-range composition value but keeps the plausible ones (#132)", () => {
    const res = mapWithingsMeasureGroup(
      measureGroup({
        grpid: 100006,
        measures: [
          { value: 999000, type: 88, unit: -3 }, // 999 kg bone mass — impossible
          { value: 55000, type: 5, unit: -3 }, // 55 kg lean mass — kept
        ],
      }),
      "UTC"
    );
    const metrics = res!.samples.map((s) => s.metric);
    expect(metrics).toContain("lean_mass_kg");
    expect(metrics).not.toContain("bone_mass_kg");
  });
});

describe("mapWithingsSleep", () => {
  function sleepSeries(over: Record<string, unknown> = {}) {
    return {
      id: 55501,
      timezone: TZ,
      startdate: SLEEP_START,
      enddate: SLEEP_END,
      date: "2023-11-14",
      data: {
        deepsleepduration: 5400, // 90 min
        lightsleepduration: 14400, // 240 min
        remsleepduration: 5400, // 90 min
        wakeupduration: 1800, // 30 min
      },
      ...over,
    };
  }

  it("maps a night to total + stage samples keyed on the sleep window", () => {
    const res = mapWithingsSleep(sleepSeries(), "UTC");
    expect(res).not.toBeNull();
    const byMetric = Object.fromEntries(
      res!.samples.map((s) => [s.metric, s.value])
    );
    // Total = deep + REM + light (awake excluded).
    expect(byMetric).toEqual({
      sleep_min: 420,
      sleep_deep_min: 90,
      sleep_rem_min: 90,
      sleep_light_min: 240,
      sleep_awake_min: 30,
    });
    // Every sample shares the same absolute window (the dedup key) + wake day.
    for (const s of res!.samples) {
      expect(s.date).toBe("2023-11-14");
      expect(s.start_time).toBe(new Date(SLEEP_START * 1000).toISOString());
      expect(s.end_time).toBe(new Date(SLEEP_END * 1000).toISOString());
    }
  });

  it("returns null for a series with no id, window, or zero sleep", () => {
    expect(mapWithingsSleep(sleepSeries({ id: null }), "UTC")).toBeNull();
    expect(
      mapWithingsSleep(sleepSeries({ startdate: null }), "UTC")
    ).toBeNull();
    expect(
      mapWithingsSleep(sleepSeries({ data: { wakeupduration: 1800 } }), "UTC")
    ).toBeNull();
  });
});
