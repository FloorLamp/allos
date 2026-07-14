import { describe, expect, it } from "vitest";
import {
  activityDisclosureSummary,
  importedActivityDetails,
  importedActivityStats,
  type ImportedActivityMetrics,
} from "@/lib/activity-import-details";

const FULL: ImportedActivityMetrics = {
  avg_hr: 148,
  max_hr: 171,
  elevation_m: 210,
  avg_speed_kmh: 23.7,
  max_speed_kmh: 41.8,
  relative_effort: 72,
  avg_power_w: 186,
  max_power_w: 612,
  weighted_avg_power_w: 193,
  avg_cadence: 88,
  avg_temp_c: 18,
  kilojoules: 692,
  workout_type: "workout",
  active_kcal: 648,
};

describe("importedActivityDetails", () => {
  it("formats every supported provider measurement", () => {
    expect(importedActivityDetails(FULL, "km")).toEqual([
      { key: "workout_type", label: "Workout type", value: "Workout" },
      {
        key: "heart_rate",
        label: "Heart rate",
        value: "148 avg · 171 max bpm",
      },
      { key: "elevation", label: "Elevation gain", value: "210 m" },
      {
        key: "speed",
        label: "Speed",
        value: "23.7 avg · 41.8 max km/h",
      },
      { key: "relative_effort", label: "Relative effort", value: "72" },
      {
        key: "power",
        label: "Power",
        value: "186 avg · 612 max · 193 weighted W",
      },
      { key: "cadence", label: "Average cadence", value: "88 rpm" },
      { key: "kilojoules", label: "Work", value: "692 kJ" },
      {
        key: "temperature",
        label: "Average temperature",
        value: "18°C",
      },
    ]);
  });

  it("converts distance-derived values to the login preference", () => {
    const byKey = new Map(
      importedActivityDetails(FULL, "mi").map((detail) => [
        detail.key,
        detail.value,
      ])
    );
    expect(byKey.get("elevation")).toBe("689 ft");
    expect(byKey.get("speed")).toBe("14.7 avg · 26 max mi/h");
  });

  it("prioritizes performance signals and keeps metadata secondary", () => {
    const stats = importedActivityStats(FULL, "km");
    expect(stats.primary.map((stat) => stat.key)).toEqual([
      "heart_rate",
      "power",
      "speed",
      "elevation",
    ]);
    expect(stats.secondary).toContainEqual({
      key: "active_kcal",
      label: "Active energy",
      value: "648 kcal",
    });
    expect(stats.secondary).toContainEqual({
      key: "kilojoules",
      label: "Mechanical work",
      value: "692 kJ",
    });
  });

  it("omits measurements the provider did not supply", () => {
    const empty = Object.fromEntries(
      Object.keys(FULL).map((key) => [key, null])
    ) as unknown as ImportedActivityMetrics;
    expect(importedActivityDetails(empty, "km")).toEqual([]);
  });

  it("summarizes calories, heart rate, and elevation for the disclosure", () => {
    expect(
      activityDisclosureSummary({
        metrics: FULL,
        distanceUnit: "km",
        calorieKcal: 648,
        calorieEstimated: false,
      })
    ).toEqual(["648 kcal", "148 bpm", "210 m"]);

    expect(
      activityDisclosureSummary({
        metrics: { ...FULL, avg_hr: null, active_kcal: null },
        distanceUnit: "mi",
        calorieKcal: 321,
        calorieEstimated: true,
      })
    ).toEqual(["≈ 321 kcal", "171 max bpm", "689 ft"]);
  });

  it("keeps a recorded zero-energy measurement in the disclosure summary", () => {
    expect(
      activityDisclosureSummary({
        metrics: { ...FULL, active_kcal: 0, avg_hr: null, max_hr: null },
        distanceUnit: "km",
        calorieKcal: 0,
        calorieEstimated: false,
      })
    ).toEqual(["0 kcal", "210 m"]);
  });
});
