import { describe, expect, it } from "vitest";
import {
  CYCLING_METRICS,
  cyclingHistoryMetricOrder,
} from "@/lib/cycling-metrics";
import { cyclingOverviewHref, cyclingRideHref } from "@/lib/hrefs";

describe("cycling navigation and metric presentation", () => {
  const lens = { metric: "power", range: "6m" } as const;

  it("carries one metric/range lens through ride and overview hrefs", () => {
    expect(cyclingRideHref(42, lens)).toBe(
      "/training/rides/42?metric=power&range=6m"
    );
    expect(cyclingOverviewHref(lens)).toBe(
      "/training?tab=analyze&kind=cardio&item=Cycling&metric=power&range=6m"
    );
  });

  it("keeps a cycling subtype in both sides of the navigation loop", () => {
    const mountainBikeLens = {
      ...lens,
      activity: "Mountain Biking",
    } as const;
    expect(cyclingRideHref(42, mountainBikeLens)).toBe(
      "/training/rides/42?metric=power&range=6m&item=Mountain+Biking"
    );
    expect(cyclingOverviewHref(mountainBikeLens)).toBe(
      "/training?tab=analyze&kind=cardio&item=Mountain+Biking&metric=power&range=6m"
    );
  });

  it("keeps the selected metric first in history without duplicating it", () => {
    expect(
      cyclingHistoryMetricOrder("power", [
        "distance",
        "duration",
        "speed",
        "power",
        "cadence",
      ])
    ).toEqual(["power", "distance", "duration", "speed", "cadence"]);
  });

  it("uses stable cycling colors across aggregate and ride-level consumers", () => {
    expect(CYCLING_METRICS.speed.color).not.toBe(CYCLING_METRICS.cadence.color);
    expect(CYCLING_METRICS.power.color).toBe("#d47506");
    expect(CYCLING_METRICS.heart_rate.color).toBe("#e11d48");
  });
});
