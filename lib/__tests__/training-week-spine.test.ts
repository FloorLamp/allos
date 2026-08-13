import { describe, expect, it } from "vitest";
import {
  WEEK_SPINE_DAYS,
  WEEK_SPINE_TYPE_LABEL,
  buildWeekSpine,
  weekSpineDaySummary,
  type WeekSpineRow,
} from "../training-week-spine";
import {
  chartActivityTypeBlock,
  chartNeutral,
  chartSeries,
} from "../chart-colors";
import { ACTIVITY_TYPES } from "../types";

// The week spine (#2566, Viz 1). Every expectation here is a PINNED LITERAL — a
// hand-computed band for a hand-written week — never a recomputation through the
// function under test.

const START = "2026-03-02"; // a Monday
const TODAY = "2026-03-05"; // the Thursday of that week

function rows(...r: WeekSpineRow[]): WeekSpineRow[] {
  return r;
}

describe("buildWeekSpine", () => {
  it("lays a week's tallies on seven cells with pinned dates, weekdays and states", () => {
    const spine = buildWeekSpine({ start: START, today: TODAY, rows: [] });

    expect(spine.days.map((d) => d.date)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(spine.days.map((d) => d.weekdayLabel)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    // Thursday is today; Fri–Sun are AHEAD, which is not a miss.
    expect(spine.days.map((d) => d.state)).toEqual([
      "past",
      "past",
      "past",
      "today",
      "ahead",
      "ahead",
      "ahead",
    ]);
    expect(spine.days).toHaveLength(WEEK_SPINE_DAYS);
    expect(spine.start).toBe(START);
    expect(spine.sessions).toBe(0);
    expect(spine.activeDays).toBe(0);
  });

  it("stacks blocks in the declared ACTIVITY_TYPES order, not arrival order", () => {
    const spine = buildWeekSpine({
      start: START,
      today: TODAY,
      rows: rows(
        { date: "2026-03-03", type: "sport", count: 1 },
        { date: "2026-03-03", type: "strength", count: 2 },
        { date: "2026-03-03", type: "recovery", count: 1 },
        { date: "2026-03-03", type: "cardio", count: 1 }
      ),
    });

    const tue = spine.days[1];
    expect(tue.date).toBe("2026-03-03");
    expect(tue.blocks).toEqual([
      { type: "strength", count: 2 },
      { type: "cardio", count: 1 },
      { type: "sport", count: 1 },
      { type: "recovery", count: 1 },
    ]);
    expect(tue.sessions).toBe(5);
  });

  it("folds the band's own sessions and active days", () => {
    const spine = buildWeekSpine({
      start: START,
      today: TODAY,
      rows: rows(
        { date: "2026-03-02", type: "strength", count: 2 },
        { date: "2026-03-04", type: "cardio", count: 1 },
        { date: "2026-03-05", type: "strength", count: 1 },
        { date: "2026-03-05", type: "sport", count: 1 }
      ),
    });

    expect(spine.sessions).toBe(5);
    expect(spine.activeDays).toBe(3);
    expect(spine.days.map((d) => d.sessions)).toEqual([2, 0, 1, 2, 0, 0, 0]);
  });

  it("ignores a row outside the band and a non-positive count", () => {
    const spine = buildWeekSpine({
      start: START,
      today: TODAY,
      rows: rows(
        { date: "2026-03-01", type: "strength", count: 3 }, // the day before
        { date: "2026-03-09", type: "cardio", count: 4 }, // the day after
        { date: "2026-03-02", type: "sport", count: 0 }
      ),
    });

    expect(spine.sessions).toBe(0);
    expect(spine.activeDays).toBe(0);
    expect(spine.days.every((d) => d.blocks.length === 0)).toBe(true);
  });

  it("sums two rows that repeat the same (day, type)", () => {
    const spine = buildWeekSpine({
      start: START,
      today: TODAY,
      rows: rows(
        { date: "2026-03-04", type: "cardio", count: 1 },
        { date: "2026-03-04", type: "cardio", count: 2 }
      ),
    });

    expect(spine.days[2].blocks).toEqual([{ type: "cardio", count: 3 }]);
    expect(spine.sessions).toBe(3);
  });

  it("marks no day 'ahead' in a rolling window that ends on today", () => {
    const spine = buildWeekSpine({
      start: "2026-02-27",
      today: "2026-03-05",
      rows: [],
    });
    expect(spine.days.map((d) => d.state)).toEqual([
      "past",
      "past",
      "past",
      "past",
      "past",
      "past",
      "today",
    ]);
  });
});

describe("weekSpineDaySummary", () => {
  it("names every type and count on the day — nothing is only in the picture", () => {
    const spine = buildWeekSpine({
      start: START,
      today: TODAY,
      rows: rows(
        { date: "2026-03-02", type: "strength", count: 2 },
        { date: "2026-03-02", type: "cardio", count: 1 }
      ),
    });
    expect(weekSpineDaySummary(spine.days[0])).toBe(
      "2026-03-02 — 2 strength, 1 cardio"
    );
  });

  it("states an empty day and an ahead day differently — 'ahead' is never a miss", () => {
    const spine = buildWeekSpine({ start: START, today: TODAY, rows: [] });
    expect(weekSpineDaySummary(spine.days[1])).toBe(
      "2026-03-03 — nothing logged"
    );
    expect(weekSpineDaySummary(spine.days[4])).toBe("2026-03-06 — ahead");
  });

  it("gives mobility and an unstated type their own honest words", () => {
    expect(WEEK_SPINE_TYPE_LABEL.recovery).toBe("mobility");
    expect(WEEK_SPINE_TYPE_LABEL.unclassified).toBe("unspecified");
  });
});

describe("the block palette", () => {
  it("draws every type's block from the validated categorical palette", () => {
    expect(chartActivityTypeBlock.strength.hex).toBe(chartSeries.violet);
    expect(chartActivityTypeBlock.cardio.hex).toBe(chartSeries.rose);
    expect(chartActivityTypeBlock.sport.hex).toBe(chartSeries.sky);
    expect(chartActivityTypeBlock.recovery.hex).toBe(chartSeries.brand);
    // `unclassified` is the DECLARED neutral, not a fifth hue: a slate block says
    // "the source did not say what this was" (#2272) rather than naming a discipline.
    expect(chartActivityTypeBlock.unclassified.hex).toBe(chartNeutral);
  });

  it("gives each type a distinct block class and covers the whole tuple", () => {
    const classes = ACTIVITY_TYPES.map(
      (t) => chartActivityTypeBlock[t].blockClass
    );
    expect(classes).toEqual([
      "bg-violet-500",
      "bg-rose-600",
      "bg-sky-600",
      "bg-brand-600",
      "bg-slate-500",
    ]);
    expect(new Set(classes).size).toBe(ACTIVITY_TYPES.length);
  });
});
