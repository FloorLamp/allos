// DB TIER — the body-measure map is not a fourth registry (issue #2556).
//
// `BODY_METRIC_MEASURE_SLUG` says which metric PAGE each `body_metrics` column
// belongs to, and the reading actions use that page for the unit conversion and the
// revalidation. `METRIC_READING_STORE` already states the same correspondence in the
// other direction. They must agree, or a corrected weight would be converted as a
// body-fat percentage — the exact class of drift the #2032 "one editability contract"
// work exists to prevent. This lives in the DB tier only because
// `lib/metric-readings.ts` opens the database.

import { describe, expect, it } from "vitest";
import { BODY_METRIC_MEASURE_SLUG } from "@/lib/body-metric-measures";
import { METRIC_READING_STORE } from "@/lib/metric-readings";
import type { BodyMetricColumn } from "@/lib/reading-identity-map";

describe("BODY_METRIC_MEASURE_SLUG agrees with METRIC_READING_STORE", () => {
  it("maps each column to the slug whose store IS that column", () => {
    for (const [column, slug] of Object.entries(BODY_METRIC_MEASURE_SLUG) as [
      BodyMetricColumn,
      keyof typeof METRIC_READING_STORE,
    ][]) {
      expect(METRIC_READING_STORE[slug], `${slug} store`).toEqual({
        table: "body_metrics",
        column,
      });
    }
  });

  it("covers every body_metrics-backed metric the registry declares", () => {
    const fromRegistry = Object.entries(METRIC_READING_STORE)
      .filter(([, store]) => store?.table === "body_metrics")
      .map(([slug]) => slug)
      .sort();
    expect(Object.values(BODY_METRIC_MEASURE_SLUG).sort()).toEqual(
      fromRegistry
    );
  });
});
