import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SleepHero from "@/app/(app)/sleep/SleepHero";
import { SLEEP_SKEW_HEDGE } from "@/lib/sleep-clock-skew";
import type { LastNightSummary } from "@/lib/sleep-summary";

// The hedge's second line names WHEN the body settled, as information (#5021).
//
// The owner's ruling is that it never reads as a bedtime: `troughStart` is the lowest
// comparable heart-rate window, which is sleep ONSET, and a person who lay awake first
// did not go to bed then. So what is asserted here is the wording as much as the value.

const SUMMARY = {
  wakeDay: "2026-08-30",
  durationMin: 298,
  bedMinutes: 9 * 60 + 39,
  wakeMinutes: 14 * 60 + 37,
} as unknown as LastNightSummary;

const hero = (props: Record<string, unknown>) => (
  <SleepHero
    summary={SUMMARY}
    timeFormat="24h"
    presentation={{ kind: "recorded" } as never}
    bedtimeSupplements={null}
    usualSleepBand={null}
    {...props}
  />
);

afterEach(cleanup);

describe("the clock-skew hedge's settled line", () => {
  it("says nothing extra when the evidence carries no instant", () => {
    render(hero({ clockSkewSuspect: true, clockSkewSettledMinutes: null }));
    expect(screen.getByTestId("sleep-clock-skew-hedge").textContent).toBe(
      SLEEP_SKEW_HEDGE
    );
    expect(screen.queryByTestId("sleep-clock-skew-settled")).toBeNull();
  });

  it("names the settled clock beneath the hedge", () => {
    render(hero({ clockSkewSuspect: true, clockSkewSettledMinutes: 3 * 60 }));
    expect(
      screen.getByTestId("sleep-clock-skew-settled").textContent
    ).toContain("Your heart rate settled around 03:00");
  });

  it("never calls it a bedtime", () => {
    // The whole reason the ruling picked these words. A confidently-worded wrong
    // bedtime is the #4299 lie in one sentence.
    render(hero({ clockSkewSuspect: true, clockSkewSettledMinutes: 3 * 60 }));
    const text = screen.getByTestId("sleep-clock-skew-hedge").textContent!;
    expect(text.toLowerCase()).not.toContain("bedtime");
    expect(text.toLowerCase()).not.toContain("you went to bed");
    expect(text.toLowerCase()).not.toContain("you slept at");
  });

  it("prints the clock in the login's own format", () => {
    render(
      hero({
        timeFormat: "12h",
        clockSkewSuspect: true,
        clockSkewSettledMinutes: 3 * 60,
      })
    );
    expect(
      screen.getByTestId("sleep-clock-skew-settled").textContent
    ).toContain("3:00 AM");
  });

  it("draws no hedge at all on a night that is not suspect", () => {
    render(hero({ clockSkewSuspect: false, clockSkewSettledMinutes: 3 * 60 }));
    expect(screen.queryByTestId("sleep-clock-skew-hedge")).toBeNull();
    expect(screen.queryByTestId("sleep-clock-skew-settled")).toBeNull();
  });
});
