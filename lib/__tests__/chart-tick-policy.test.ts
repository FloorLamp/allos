import { describe, expect, it } from "vitest";
// The value-axis half of the policy is recharts' own step algorithm, so the
// arithmetic that will run at render time is what gets asserted here. The deep
// path is deliberate and test-only: `getNiceTickValues` is re-exported from the
// package root but `getTickValuesFixedDomain` — the branch a DECLARED numeric
// domain takes (recharts' `combineNiceTicks`) — is not, and pinning one branch
// while guessing the other is how Mood's five ticks would go untested.
// recharts publishes its declarations under ./types, not beside ./lib, so this
// deep CJS path has none. The signature is re-declared below rather than guessed:
// it is the one `combineNiceTicks` calls with the scaffold's two props.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no declaration file at this deep path
import * as rechartsTicks from "recharts/lib/util/scale/getNiceTickValues.js";

type NiceTickFn = (
  domain: [number, number],
  tickCount: number,
  allowDecimals: boolean,
  mode: "snap125" | "adaptive"
) => number[];
const getNiceTickValues = rechartsTicks.getNiceTickValues as NiceTickFn;
const getTickValuesFixedDomain =
  rechartsTicks.getTickValuesFixedDomain as NiceTickFn;
import {
  calendarTickStepDays,
  categoryDateTicks,
  CHART_DATE_AXIS_TICKS,
  CHART_VALUE_AXIS_NICE_TICKS,
  CHART_VALUE_AXIS_TICKS,
} from "../chart-time-axis";

// THE TICK POLICY, OVER THE DOMAINS THAT PRODUCED THE COMPLAINT (#4924).
//
// The issue is a screenshot of /trends and the phrase "why are these so janky",
// and three of the six charts in it were janky in the axis: Sleep printed
// 4.75 / 5.7 / 6.65 / 7.6 / 8.55, Heart Rate printed 55 / 66 / 77 / 88 / 99, and
// Mood — a 1-5 rating — printed a 2-4 axis with a reading sitting on the axis
// line. Those are recharts' `adaptive` fit at its default five ticks: honest
// divisions of the data range, and not numbers anybody reads a chart in.
//
// A tick policy verified by eye is not verified, and the eye is exactly what
// noticed here. So the three real domains go through the policy as a table.

/** What the axis will actually draw, given the scaffold's props. */
function valueAxisTicks(
  domain: [number, number],
  { declared }: { declared: boolean }
): number[] {
  // recharts routes an ["auto","auto"] domain through getNiceTickValues (which may
  // widen the domain to the outermost tick) and a declared numeric domain through
  // getTickValuesFixedDomain (which may not). Same step algorithm, same count.
  const fn = declared ? getTickValuesFixedDomain : getNiceTickValues;
  return fn(domain, CHART_VALUE_AXIS_TICKS, true, CHART_VALUE_AXIS_NICE_TICKS);
}

describe("the value-axis tick policy (#4924)", () => {
  it.each([
    // [what, domain, declared?, ticks]
    ["Sleep hours, auto domain", [4.75, 8.55], false, [4, 5, 6, 7, 8, 9]],
    ["Heart rate bpm, auto domain", [59, 95], false, [50, 60, 70, 80, 90, 100]],
    ["Mood, declared 1-5", [1, 5], true, [1, 2, 3, 4, 5]],
  ] as const)("%s", (_what, domain, declared, expected) => {
    expect(valueAxisTicks([...domain], { declared })).toEqual([...expected]);
  });

  it("says something recharts' default did not", () => {
    // The CONVERSE, in the same file: a policy that reproduces the default is a
    // policy nobody needed. These are the exact tick sets the issue recorded off
    // the screenshot, and they must not be what the policy now produces.
    expect(getNiceTickValues([4.75, 8.55], 5, true, "adaptive")).toEqual([
      4.75, 5.7, 6.65, 7.6, 8.55,
    ]);
    expect(getNiceTickValues([59, 95], 5, true, "adaptive")).toEqual([
      55, 66, 77, 88, 99,
    ]);
    for (const domain of [
      [4.75, 8.55],
      [59, 95],
    ] as const) {
      expect(valueAxisTicks([...domain], { declared: false })).not.toEqual(
        getNiceTickValues([...domain], 5, true, "adaptive")
      );
    }
  });

  it.each([
    // The acceptance criteria in their own words: Sleep's ticks are integers or
    // halves, HR's are multiples of 5, Mood plots all five of its ratings.
    ["Sleep", [4.75, 8.55] as [number, number], false, 0.5],
    ["Heart rate", [59, 95] as [number, number], false, 5],
  ])("%s ticks land on a step a reader names", (_m, domain, declared, unit) => {
    for (const tick of valueAxisTicks(domain, { declared })) {
      expect(Math.abs(tick / unit - Math.round(tick / unit))).toBeLessThan(
        1e-9
      );
    }
  });
});

// ── THE DATE AXIS ───────────────────────────────────────────────────────────

/** `count` consecutive ISO days ending on `last` (inclusive). */
function days(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10)
  );
}

describe("the date-axis tick policy (#4924)", () => {
  it.each([
    // [span in days, step] — the smallest ladder rung that fits inside 7 ticks.
    [6, 1],
    [13, 2],
    [29, 7],
    [89, 14],
    [180, 28],
    [364, 91],
    [1095, 182],
  ])("a %i-day span steps every %i days", (span, step) => {
    expect(calendarTickStepDays(span)).toBe(step);
    expect(Math.floor(span / step) + 1).toBeLessThanOrEqual(
      CHART_DATE_AXIS_TICKS
    );
  });

  it("the 90-day default window gets a fortnightly axis, ending on its last day", () => {
    const window = days("2026-09-03", 90);
    const ticks = categoryDateTicks(window);
    expect(ticks).toEqual([
      "2026-06-11",
      "2026-06-25",
      "2026-07-09",
      "2026-07-23",
      "2026-08-06",
      "2026-08-20",
      "2026-09-03",
    ]);
    // The window's own last day carries a tick even when nothing was logged on
    // it — the #2258 guarantee e2e/trends-day-gaps.spec.ts pins.
    expect(ticks.at(-1)).toBe(window.at(-1));
    // …and in axis order, so recharts maps them left to right.
    expect([...ticks].sort()).toEqual(ticks);
  });

  it.each([
    ["a five-day window labels every day", days("2026-09-03", 5), 5],
    ["a fortnight labels every other day", days("2026-09-03", 14), 7],
    ["a 30-day window labels weekly", days("2026-09-03", 30), 5],
    ["a 90-day window labels fortnightly", days("2026-09-03", 90), 7],
    ["a year labels quarterly", days("2026-09-03", 365), 5],
  ])("%s", (_what, window, count) => {
    expect(categoryDateTicks(window)).toHaveLength(count);
  });

  it("snaps to categories the axis actually has", () => {
    // A gap-exempt series (lab draws) has no calendar fill, so a fortnightly
    // target lands between two categories; the tick takes the nearer one rather
    // than a value the axis cannot place.
    const sparse = ["2026-06-01", "2026-07-04", "2026-08-02", "2026-09-03"];
    const ticks = categoryDateTicks(sparse);
    for (const tick of ticks) expect(sparse).toContain(tick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it.each([
    ["empty", [] as string[], []],
    ["one day", ["2026-09-03"], ["2026-09-03"]],
    ["two days", ["2026-09-02", "2026-09-03"], ["2026-09-02", "2026-09-03"]],
  ])("%s is left alone", (_what, input, expected) => {
    expect(categoryDateTicks(input)).toEqual(expected);
  });
});
