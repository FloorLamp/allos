import { describe, it, expect } from "vitest";
import {
  TREND_METRIC_PRESENTATION_FLOORS,
  missingTrendMetricFloors,
  trendMetricPresentationFreshness,
} from "@/lib/trend-metric-freshness";
import { TREND_METRIC_SLUGS } from "@/lib/trend-metrics";
import { VITAL_PRESENTATION_FLOORS } from "@/lib/vitals-latest";

// The Trends chart cards' presentation floors (#2615 item 3). What is asserted here is
// the SHAPE of the registry, not its taste: that every metric declares a floor, that a
// quantity which already had one somewhere else did not get a second answer, and that
// the boundary is the shared one.

const TODAY = "2026-08-12";

describe("every trend metric declares a presentation floor", () => {
  it("leaves none undeclared", () => {
    // The record is total over the slug union, so this can only fail if the registry is
    // hand-edited out of sync with the slug list — which is exactly when a silent
    // fallback would be worst.
    expect(missingTrendMetricFloors()).toEqual([]);
  });

  it("declares a positive interval with a spoken label for each", () => {
    for (const slug of TREND_METRIC_SLUGS) {
      const floor = TREND_METRIC_PRESENTATION_FLOORS[slug];
      expect(floor.days).toBeGreaterThan(0);
      expect(floor.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("a quantity that already had a floor keeps exactly one", () => {
  it("takes blood pressure and resting HR from the vitals registry by reference", () => {
    // Two registries disagreeing about how old a blood pressure may be is the drift this
    // avoids by construction. Identity, not equality: a copied number could drift.
    expect(TREND_METRIC_PRESENTATION_FLOORS.systolic).toBe(
      VITAL_PRESENTATION_FLOORS["blood-pressure"]
    );
    expect(TREND_METRIC_PRESENTATION_FLOORS.diastolic).toBe(
      VITAL_PRESENTATION_FLOORS["blood-pressure"]
    );
    expect(TREND_METRIC_PRESENTATION_FLOORS["resting-hr"]).toBe(
      VITAL_PRESENTATION_FLOORS["resting-hr"]
    );
  });
});

describe("the floors differ where the cadence differs", () => {
  it("calls a fortnight-old temperature history and a fortnight-old height current", () => {
    // The whole argument for a per-metric floor rather than one global number: the same
    // fourteen days is stale for one quantity and unremarkable for another. This is the
    // exact reading #2615 reported — 99.2 °F, fourteen days old, headlined with no date.
    expect(
      trendMetricPresentationFreshness("temperature", "2026-07-29", TODAY)
    ).toBe("due");
    expect(
      trendMetricPresentationFreshness("height", "2026-07-29", TODAY)
    ).toBe("current");
  });

  it("goes stale STRICTLY after the interval, like every other freshness reader", () => {
    // Boundary comes from lib/freshness, not from here: a reading exactly one interval
    // old is still current and comes due tomorrow.
    expect(
      trendMetricPresentationFreshness("temperature", "2026-08-05", TODAY)
    ).toBe("current");
    expect(
      trendMetricPresentationFreshness("temperature", "2026-08-04", TODAY)
    ).toBe("due");
  });
});

describe("an unknowable age claims nothing", () => {
  it("answers not-applicable rather than due for a missing date or day", () => {
    // Never folded into `due`: nothing is known about the age, so no claim is withdrawn
    // and none is made.
    expect(trendMetricPresentationFreshness("weight", null, TODAY)).toBe(
      "not-applicable"
    );
    expect(trendMetricPresentationFreshness("weight", "2026-07-29", null)).toBe(
      "not-applicable"
    );
  });
});
