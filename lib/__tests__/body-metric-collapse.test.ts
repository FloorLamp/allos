import { describe, expect, it } from "vitest";
import { toKg } from "@/lib/units";
import { collapseBodyMetricsByDate } from "@/lib/integrations/body-metric-collapse";
import type { NormBodyMetric } from "@/lib/integrations/normalize";

// #605: multiple same-date readings in one batch must collapse to ONE row per date,
// with the LATEST reading (by measured_at) winning per field — independent of the
// order the provider API returned them. This is what stops a two-weigh-in day from
// flip-flopping the stored value and churning "N changed" every re-scan.

describe("collapseBodyMetricsByDate (#605)", () => {
  const early: NormBodyMetric = {
    date: "2024-05-01",
    measured_at: "2024-05-01T07:00:00Z",
    weight_kg: toKg(75.4, "kg"),
  };
  const late: NormBodyMetric = {
    date: "2024-05-01",
    measured_at: "2024-05-01T22:00:00Z",
    weight_kg: toKg(76.1, "kg"),
  };

  it("keeps the latest reading regardless of input order", () => {
    const forward = collapseBodyMetricsByDate([early, late]);
    const reverse = collapseBodyMetricsByDate([late, early]);
    expect(forward).toEqual([
      { date: "2024-05-01", weight_kg: toKg(76.1, "kg") },
    ]);
    // Order-independent: the newest-first order Withings returns yields the same value.
    expect(reverse).toEqual(forward);
    expect(forward).toHaveLength(1);
  });

  it("folds field-by-field: latest non-null wins per field", () => {
    const rows: NormBodyMetric[] = [
      {
        date: "2024-05-02",
        measured_at: "2024-05-02T07:00:00Z",
        weight_kg: toKg(80, "kg"),
        body_fat_pct: 18,
      },
      {
        date: "2024-05-02",
        measured_at: "2024-05-02T21:00:00Z",
        weight_kg: toKg(79.5, "kg"),
        resting_hr: 55,
      },
    ];
    // weight from the later reading (79.5), body fat only the earlier had (18),
    // resting HR only the later had (55).
    expect(collapseBodyMetricsByDate(rows)).toEqual([
      {
        date: "2024-05-02",
        weight_kg: toKg(79.5, "kg"),
        body_fat_pct: 18,
        resting_hr: 55,
      },
    ]);
  });

  it("leaves distinct dates untouched and preserves date order", () => {
    const rows: NormBodyMetric[] = [
      { date: "2024-05-03", weight_kg: toKg(70, "kg") },
      { date: "2024-05-04", weight_kg: toKg(71, "kg") },
    ];
    expect(collapseBodyMetricsByDate(rows)).toEqual(rows);
  });

  it("carries partial_day through a same-date collapse (#606)", () => {
    const rows: NormBodyMetric[] = [
      { date: "2024-05-05", resting_hr: 60, partial_day: true },
      {
        date: "2024-05-05",
        measured_at: "2024-05-05T21:00:00Z",
        resting_hr: 62,
      },
    ];
    const [out] = collapseBodyMetricsByDate(rows);
    expect(out.partial_day).toBe(true);
    expect(out.resting_hr).toBe(62);
  });

  it("is a no-op for already-unique-per-date rows (Health Connect)", () => {
    const rows: NormBodyMetric[] = [
      {
        date: "2024-05-06",
        weight_kg: toKg(70, "kg"),
        body_fat_pct: 20,
        resting_hr: 58,
      },
    ];
    expect(collapseBodyMetricsByDate(rows)).toEqual(rows);
  });
});
