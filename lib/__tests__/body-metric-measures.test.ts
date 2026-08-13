// PURE TIER — the wide body_metrics row's per-measure targets (issue #2556).

import { describe, expect, it } from "vitest";
import {
  BODY_METRIC_MEASURE_SLUG,
  bodyMetricMeasures,
} from "@/lib/body-metric-measures";
import { parseReadingTarget } from "@/lib/reading-placement";

const FULL_ROW = {
  id: 42,
  weight_kg: 80,
  body_fat_pct: 17.24,
  resting_hr: 54,
};

describe("bodyMetricMeasures", () => {
  it("offers one measure per PRESENT cell, in column order", () => {
    expect(bodyMetricMeasures(FULL_ROW, "kg").map((m) => m.column)).toEqual([
      "weight_kg",
      "body_fat_pct",
      "resting_hr",
    ]);
  });

  // The whole reason the menu is built from the row rather than from the column
  // list: a day that only holds a weigh-in must not offer to correct a body fat
  // percentage that was never recorded.
  it("omits an absent cell entirely", () => {
    const measures = bodyMetricMeasures(
      { id: 7, weight_kg: 80, body_fat_pct: null, resting_hr: null },
      "kg"
    );
    expect(measures.map((m) => m.column)).toEqual(["weight_kg"]);
  });

  it("answers nothing for a row with no measures at all", () => {
    expect(
      bodyMetricMeasures(
        { id: 7, weight_kg: null, body_fat_pct: null, resting_hr: null },
        "kg"
      )
    ).toEqual([]);
  });

  // The target is the row's OWN address, so the action never re-derives a store
  // from the page it was posted from (#2032).
  it("names the physical row and column in a target the write path parses back", () => {
    for (const measure of bodyMetricMeasures(FULL_ROW, "kg")) {
      expect(parseReadingTarget(measure.target)).toEqual({
        store: "body_metrics",
        id: 42,
        column: measure.column,
      });
    }
  });

  // Weight is the ONE converted measure. The dialog opens on the number the table
  // shows, and `updateMetricReading` converts it back with toKg at the boundary.
  it("opens weight in the login's display unit and leaves the others alone", () => {
    const kg = bodyMetricMeasures(FULL_ROW, "kg");
    expect(kg[0]).toMatchObject({ value: 80, unit: " kg", slug: "weight" });

    const lb = bodyMetricMeasures(FULL_ROW, "lb");
    expect(lb[0].unit).toBe(" lb");
    expect(lb[0].value).toBeCloseTo(176.4, 1);

    // Body fat rounds to the one decimal its column renders; resting HR is whole.
    expect(kg[1]).toMatchObject({ value: 17.2, unit: "%", slug: "body-fat" });
    expect(kg[2]).toMatchObject({
      value: 54,
      unit: " bpm",
      slug: "resting-hr",
    });
  });

  it("every column declares the metric page whose unit and routes the write uses", () => {
    expect(BODY_METRIC_MEASURE_SLUG).toEqual({
      weight_kg: "weight",
      body_fat_pct: "body-fat",
      resting_hr: "resting-hr",
    });
  });
});
