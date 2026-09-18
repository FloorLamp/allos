import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SleepHero from "@/app/(app)/sleep/SleepHero";
import type { LastNightSummary } from "@/lib/sleep-summary";

// ONE CELL, ONLY WHEN PRESENT (#5409, owner ruling 2026-09-11).
//
// A NEW FILE rather than a case in `sleep-hero-settled.test.tsx`, because that file is
// about the clock-skew hedge and every one of its cases renders a SUSPECT night; this
// one is about a cell that has nothing to do with skew and has to be asserted on an
// ordinary night. The hero's own render is the only place the "only when present" half
// is observable — the field is nullable in the model, and a surface that quietly drew a
// zero or an em-dash would still typecheck.
//
// The rendered value is not asserted from a literal: it is the same
// `formatBreathingRate` the record's Sleep row uses, and the point of the assertion is
// the spelling — one decimal, no trailing zero, ` br/min` — which is what keeps two
// surfaces from rounding one vendor number two ways.

const summary = (breathingRateBpm: number | null) =>
  ({
    wakeDay: "2026-09-05",
    durationMin: 361,
    bedMinutes: 2 * 60 + 52,
    wakeMinutes: 8 * 60 + 53,
    baselineAvgMin: null,
    deltaMin: null,
    baselineNights: 0,
    stages: null,
    source: "health-connect",
    breathingRateBpm,
  }) as LastNightSummary;

const hero = (breathingRateBpm: number | null) => (
  <SleepHero
    summary={summary(breathingRateBpm)}
    timeFormat="24h"
    presentation={{ freshness: "last-night", label: "Last night" }}
    bedtimeSupplements={null}
    usualSleepBand={null}
  />
);

afterEach(cleanup);

describe("the Sleep hero's breathing-rate cell", () => {
  it("states the night's reading beside the other facts", () => {
    render(hero(13.6));
    expect(screen.getByTestId("sleep-hero-breathing-rate").textContent).toBe(
      "13.6 br/min"
    );
  });

  it("drops the trailing zero on a whole number", () => {
    render(hero(14));
    expect(screen.getByTestId("sleep-hero-breathing-rate").textContent).toBe(
      "14 br/min"
    );
  });

  it("renders NOTHING on a night with no reading — not a zero, not a dash", () => {
    render(hero(null));
    expect(screen.queryByTestId("sleep-hero-breathing-rate")).toBeNull();
    // The rest of the hero is untouched: this is an addition, and a manual logger's
    // hero has to read exactly as it did before #5409.
    expect(screen.getByTestId("sleep-hero-duration")).not.toBeNull();
    expect(screen.getByTestId("sleep-hero")).not.toBeNull();
    expect(screen.getByTestId("sleep-hero").textContent).not.toContain(
      "br/min"
    );
  });
});
