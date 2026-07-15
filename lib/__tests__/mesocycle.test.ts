// Pure tests for the mesocycle week-in-cycle math (#741): weekInCycle, the
// pause-re-anchoring effectiveCycleStart at the CYCLE_PAUSE_GAP_DAYS boundary and the
// no-credited-sessions case, and the deload-week / weeks-until helpers.
import { describe, it, expect } from "vitest";
import {
  CYCLE_PAUSE_GAP_DAYS,
  effectiveCycleStart,
  weekInCycle,
  isDeloadWeek,
  weeksUntilDeload,
} from "../mesocycle";
import { shiftDateStr } from "../date";

const START = "2026-01-05"; // a Monday

describe("weekInCycle", () => {
  it("counts calendar weeks from the effective start, modulo the cycle", () => {
    expect(weekInCycle(START, START, 9)).toBe(0); // day 0
    expect(weekInCycle(START, shiftDateStr(START, 6), 9)).toBe(0); // day 6
    expect(weekInCycle(START, shiftDateStr(START, 7), 9)).toBe(1); // day 7
    expect(weekInCycle(START, shiftDateStr(START, 55), 9)).toBe(7); // week 7
    expect(weekInCycle(START, shiftDateStr(START, 56), 9)).toBe(8); // deload week
    expect(weekInCycle(START, shiftDateStr(START, 63), 9)).toBe(0); // wraps
  });

  it("clamps a future/invalid effective start to week 0", () => {
    expect(weekInCycle(START, shiftDateStr(START, -3), 9)).toBe(0);
    expect(weekInCycle("not-a-date", START, 9)).toBe(0);
    expect(weekInCycle(START, START, 0)).toBe(0);
  });
});

describe("isDeloadWeek / weeksUntilDeload", () => {
  it("marks the LAST week of the cycle as the deload week", () => {
    expect(isDeloadWeek(8, 9)).toBe(true);
    expect(isDeloadWeek(7, 9)).toBe(false);
    expect(isDeloadWeek(0, 9)).toBe(false);
  });

  it("requires a multi-week cycle (a 1-week cycle has no distinct deload)", () => {
    expect(isDeloadWeek(0, 1)).toBe(false);
  });

  it("counts whole weeks until the cycle's deload week, 0 during it", () => {
    expect(weeksUntilDeload(8, 9)).toBe(0); // this IS the deload week
    expect(weeksUntilDeload(7, 9)).toBe(1); // next week
    expect(weeksUntilDeload(6, 9)).toBe(2);
    expect(weeksUntilDeload(0, 9)).toBe(8);
  });
});

describe("effectiveCycleStart — no re-anchor without a long gap", () => {
  it("with no credited sessions inside the window, keeps started_date", () => {
    // today is within CYCLE_PAUSE_GAP_DAYS of the start → still the naive start.
    const today = shiftDateStr(START, 10);
    expect(effectiveCycleStart(START, [], today)).toBe(START);
  });

  it("with regular sessions (no gap ≥ boundary), keeps started_date", () => {
    const dates = [0, 3, 6, 9, 12, 15].map((d) => shiftDateStr(START, d));
    const today = shiftDateStr(START, 16);
    expect(effectiveCycleStart(START, dates, today)).toBe(START);
  });
});

describe("effectiveCycleStart — pause re-anchoring at the boundary", () => {
  it("re-anchors to the first session AFTER a gap of exactly CYCLE_PAUSE_GAP_DAYS", () => {
    const trained = shiftDateStr(START, 5);
    const returned = shiftDateStr(trained, CYCLE_PAUSE_GAP_DAYS); // gap == 21
    const today = shiftDateStr(returned, 3);
    expect(effectiveCycleStart(START, [trained, returned], today)).toBe(
      returned
    );
  });

  it("does NOT re-anchor one day under the boundary", () => {
    const trained = shiftDateStr(START, 5);
    const returned = shiftDateStr(trained, CYCLE_PAUSE_GAP_DAYS - 1); // gap == 20
    const today = shiftDateStr(returned, 3);
    expect(effectiveCycleStart(START, [trained, returned], today)).toBe(START);
  });

  it("re-anchors to today during an ONGOING pause (no session yet)", () => {
    const trained = shiftDateStr(START, 5);
    const today = shiftDateStr(trained, CYCLE_PAUSE_GAP_DAYS + 4);
    // Last session was >21 days ago and nothing since → returner is in week 1.
    expect(effectiveCycleStart(START, [trained], today)).toBe(today);
    expect(
      weekInCycle(effectiveCycleStart(START, [trained], today), today, 9)
    ).toBe(0);
  });

  it("re-anchors to today when never trained and the start itself is stale", () => {
    const today = shiftDateStr(START, CYCLE_PAUSE_GAP_DAYS + 1);
    expect(effectiveCycleStart(START, [], today)).toBe(today);
  });

  it("uses the MOST RECENT re-anchor across multiple pauses", () => {
    const s1 = shiftDateStr(START, 3);
    const back1 = shiftDateStr(s1, 25); // gap 1 → re-anchor here
    const s2 = shiftDateStr(back1, 4);
    const back2 = shiftDateStr(s2, 30); // gap 2 → re-anchor here (latest wins)
    const today = shiftDateStr(back2, 2);
    expect(effectiveCycleStart(START, [s1, back1, s2, back2], today)).toBe(
      back2
    );
  });

  it("ignores unsorted / duplicate / out-of-range input dates", () => {
    const trained = shiftDateStr(START, 5);
    const returned = shiftDateStr(trained, 25);
    const today = shiftDateStr(returned, 2);
    const messy = [
      returned,
      "2020-01-01", // before start → ignored
      trained,
      returned, // dup
      shiftDateStr(today, 5), // after today → ignored
    ];
    expect(effectiveCycleStart(START, messy, today)).toBe(returned);
  });
});
