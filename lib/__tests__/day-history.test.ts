import { describe, expect, it } from "vitest";
import {
  DAY_HISTORY_DOMAINS,
  FOLDED_ROW_KEY,
  MAX_HISTORY_DAY_WEEKS,
  MAX_HISTORY_WEEK_COLUMNS,
  activeHistoryWeeks,
  bucketWord,
  buildDayHistoryCalendar,
  buildDayHistoryRows,
  buildDayHistoryStrip,
  dayHistoryStart,
  dayHistoryWindow,
  dayTotals,
  historyBucket,
  historyBucketCoverage,
  historyBuckets,
  historyDays,
  historyWeeks,
  weeklyIntensityLevel,
  type DayHistoryDomainKey,
  type DayHistoryValue,
} from "../day-history";

describe("DAY_HISTORY_DOMAINS", () => {
  const keys = Object.keys(DAY_HISTORY_DOMAINS) as DayHistoryDomainKey[];

  it("every domain declares a complete spec", () => {
    for (const key of keys) {
      const spec = DAY_HISTORY_DOMAINS[key];
      expect(spec.unitOne.length).toBeGreaterThan(0);
      expect(spec.unitMany.length).toBeGreaterThan(0);
      expect(spec.groupOne.length).toBeGreaterThan(0);
      expect(spec.groupMany.length).toBeGreaterThan(0);
      expect(["activity", "observation"]).toContain(spec.ramp);
      expect(["coverage", "quantity"]).toContain(spec.calendarKind);
      expect(spec.calendarTitle.length).toBeGreaterThan(0);
      expect(spec.matrixTitle.length).toBeGreaterThan(0);
      expect(spec.helperText.length).toBeGreaterThan(0);
      expect(spec.levelLabels).toHaveLength(5);
      expect(typeof spec.calendarLevel).toBe("function");
      expect(typeof spec.cellLevel).toBe("function");
      // The WEEK-grain half of the declaration (#2413). A domain that grows a
      // day ladder and forgets its week twin fails HERE rather than rendering a
      // saturated strip nobody can read.
      expect(spec.weekCalendarTitle.length).toBeGreaterThan(0);
      expect(spec.weekLevelLabels).toHaveLength(5);
      expect(typeof spec.weekCellLevel).toBe("function");
      expect(typeof spec.weekStripLevel).toBe("function");
    }
  });

  it("levels are 0 exactly at zero and monotonic over rising values", () => {
    for (const key of keys) {
      const spec = DAY_HISTORY_DOMAINS[key];
      for (const level of [
        spec.calendarLevel,
        spec.cellLevel,
        spec.weekCellLevel,
        spec.weekStripLevel,
      ]) {
        expect(level(0)).toBe(0);
        expect(level(1)).toBeGreaterThan(0);
        let prev = 0;
        for (let v = 0; v <= 12; v++) {
          const l = level(v);
          expect(l).toBeGreaterThanOrEqual(prev);
          expect(l).toBeGreaterThanOrEqual(0);
          expect(l).toBeLessThanOrEqual(4);
          prev = l;
        }
      }
      expect(spec.cellLevel(12)).toBe(4);
      expect(spec.calendarLevel(12)).toBe(
        spec.calendarKind === "coverage" ? 1 : 4
      );
      // A week ladder must still reach its top step within a plausible week.
      expect(spec.weekCellLevel(40)).toBe(4);
      expect(spec.weekStripLevel(40)).toBe(
        spec.calendarKind === "coverage" ? 1 : 4
      );
    }
  });

  it("food and dose calendars encode coverage, not a more-is-better total", () => {
    for (const key of ["food", "dose"] as const) {
      const spec = DAY_HISTORY_DOMAINS[key];
      expect(spec.calendarLevel(1)).toBe(1);
      expect(spec.calendarLevel(20)).toBe(1);
      expect(spec.cellLevel(4)).toBe(4);
    }
  });

  // The coverage decision is a claim about what a total MEANS, so re-grading it
  // by seven would have been a rescale of the wrong thing: a twelve-serving
  // week must not glow better than a three-serving one, for exactly the reason
  // a twelve-serving day must not.
  it("food and dose STRIPS stay coverage at week grain", () => {
    for (const key of ["food", "dose"] as const) {
      const spec = DAY_HISTORY_DOMAINS[key];
      expect(spec.weekStripLevel(1)).toBe(1);
      expect(spec.weekStripLevel(60)).toBe(1);
    }
  });

  it("week ladders do not saturate on an ordinary week", () => {
    // A daily supplement is 7 doses a week and must not sit on the top step.
    expect(DAY_HISTORY_DOMAINS.dose.weekCellLevel(7)).toBe(1);
    expect(DAY_HISTORY_DOMAINS.dose.weekCellLevel(14)).toBe(2);
    // Four servings of one food group across a whole week is unremarkable.
    expect(DAY_HISTORY_DOMAINS.food.weekCellLevel(4)).toBe(2);
    expect(DAY_HISTORY_DOMAINS.food.cellLevel(4)).toBe(4);
    // Four workouts in a week is a strong week for the WHOLE strip, not the top.
    expect(DAY_HISTORY_DOMAINS.workout.weekStripLevel(4)).toBe(1);
    expect(DAY_HISTORY_DOMAINS.workout.weekStripLevel(21)).toBe(3);
  });

  it("the week-level legend names the week ladder's own buckets", () => {
    const keys2 = Object.keys(DAY_HISTORY_DOMAINS) as DayHistoryDomainKey[];
    for (const key of keys2) {
      const spec = DAY_HISTORY_DOMAINS[key];
      expect(spec.weekLevelLabels[0]).toBe("0");
      // Every label above zero names a bucket the ladder actually reaches.
      expect(new Set(spec.weekLevelLabels).size).toBe(5);
    }
  });
});

describe("weeklyIntensityLevel", () => {
  it("is the shared day ladder with its boundaries taken x7", () => {
    expect(weeklyIntensityLevel(0)).toBe(0);
    expect(weeklyIntensityLevel(1)).toBe(1);
    expect(weeklyIntensityLevel(7)).toBe(1);
    expect(weeklyIntensityLevel(8)).toBe(2);
    expect(weeklyIntensityLevel(14)).toBe(2);
    expect(weeklyIntensityLevel(21)).toBe(3);
    expect(weeklyIntensityLevel(22)).toBe(4);
  });
});

describe("historyDays", () => {
  it("enumerates the inclusive span ascending", () => {
    expect(historyDays("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("a single-day span is that day", () => {
    expect(historyDays("2026-07-01", "2026-07-01")).toEqual(["2026-07-01"]);
  });
});

const V = (
  date: string,
  group: string,
  value: number,
  detail?: number
): DayHistoryValue => ({ date, group, value, detail });

describe("dayTotals", () => {
  const values = [
    V("2026-07-01", "a", 2),
    V("2026-07-01", "b", 1),
    V("2026-07-02", "a", 1),
    V("2026-07-02", "c", 0),
  ];

  it("sums per day across groups", () => {
    const totals = dayTotals(values, null);
    expect(totals.get("2026-07-01")).toBe(3);
    expect(totals.get("2026-07-02")).toBe(1);
  });

  it("honors the selected-group filter and ignores non-positive values", () => {
    const totals = dayTotals(values, new Set(["b", "c"]));
    expect(totals.get("2026-07-01")).toBe(1);
    expect(totals.has("2026-07-02")).toBe(false);
  });
});

describe("buildDayHistoryRows", () => {
  const days = historyDays("2026-07-01", "2026-07-04");
  const groups = [
    { key: "a", label: "Alpha", foodSlug: "a", tier: "encourage" },
    { key: "b", label: "Beta" },
    { key: "c", label: "Gamma" },
    { key: "d", label: "Delta" },
  ];
  const cellLevel = DAY_HISTORY_DOMAINS.food.cellLevel;

  it("ranks by window total descending, ties by vocabulary order", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [
        V("2026-07-01", "b", 1),
        V("2026-07-02", "b", 1),
        V("2026-07-01", "a", 1),
        V("2026-07-03", "c", 1),
      ],
      groups,
      selected: null,
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    // b (2) first, then the a/c tie resolves in vocabulary order.
    expect(rows.map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(rows[0].total).toBe(2);
    expect(rows[0].activeDays).toBe(2);
  });

  it("cells are dense over the day list, today flagged, details summed", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [V("2026-07-02", "a", 1, 30), V("2026-07-02", "a", 1, 40)],
      groups,
      selected: null,
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows).toHaveLength(1);
    const cells = rows[0].cells;
    expect(cells).toHaveLength(days.length);
    expect(cells.map((c) => c.value)).toEqual([0, 2, 0, 0]);
    expect(cells[1].detail).toBe(70);
    expect(cells[1].level).toBe(cellLevel(2));
    expect(cells.map((c) => c.today)).toEqual([false, false, false, true]);
    expect(rows[0].foodSlug).toBe("a");
    expect(rows[0].tier).toBe("encourage");
  });

  it("folds rows beyond maxRows into one aggregate row", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [
        V("2026-07-01", "a", 4),
        V("2026-07-01", "b", 3),
        V("2026-07-01", "c", 2),
        V("2026-07-02", "d", 1),
      ],
      groups,
      selected: null,
      maxRows: 3,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", FOLDED_ROW_KEY]);
    const fold = rows[2];
    expect(fold.label).toBe("+2 more");
    expect(fold.foldedKeys).toEqual(["c", "d"]);
    expect(fold.total).toBe(3);
    // The fold's cells aggregate its members per day.
    expect(fold.cells.map((c) => c.value)).toEqual([2, 1, 0, 0]);
  });

  it("a single overflow group keeps its own row — a fold of one hides nothing", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [
        V("2026-07-01", "a", 3),
        V("2026-07-01", "b", 2),
        V("2026-07-01", "c", 1),
      ],
      groups,
      selected: null,
      maxRows: 3,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(rows[2].foldedKeys).toEqual([]);
  });

  it("the selected filter removes groups before ranking and folding", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [V("2026-07-01", "a", 5), V("2026-07-01", "b", 1)],
      groups,
      selected: new Set(["b"]),
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows.map((r) => r.key)).toEqual(["b"]);
  });

  it("collects unique value notes per cell, and the fold row merges them", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [
        { date: "2026-07-01", group: "a", value: 1, note: "500 mg" },
        { date: "2026-07-01", group: "a", value: 1, note: "500 mg" },
        { date: "2026-07-01", group: "a", value: 1, note: "1000 mg" },
      ],
      groups,
      selected: null,
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows[0].cells[0].notes).toEqual(["500 mg", "1000 mg"]);
    expect(rows[0].cells[1].notes).toEqual([]);
  });

  it("rows carry the abbreviated label, falling back to the full one", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [
        { date: "2026-07-01", group: "a", value: 1 },
        { date: "2026-07-01", group: "b", value: 1 },
      ],
      groups: [
        { key: "a", label: "Alpha Workout", short: "Alpha" },
        { key: "b", label: "Beta" },
      ],
      selected: null,
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows.find((r) => r.key === "a")?.short).toBe("Alpha");
    expect(rows.find((r) => r.key === "b")?.short).toBe("Beta");
  });

  it("an unknown group key still renders, labeled by its key", () => {
    const rows = buildDayHistoryRows({
      days,
      values: [V("2026-07-01", "retired_group", 1)],
      groups,
      selected: null,
      maxRows: 8,
      cellLevel,
      today: "2026-07-04",
    });
    expect(rows[0].label).toBe("retired_group");
    expect(rows[0].foodSlug).toBeNull();
  });
});

describe("activeHistoryWeeks", () => {
  it("trims leading all-empty weeks to the week of the first value", () => {
    // end = Wed 2026-07-08, weekStart 0. First value Jul 1 (Wed of the prior
    // week) → 2 week columns instead of the requested 13.
    expect(
      activeHistoryWeeks(
        [{ date: "2026-07-01", group: "a", value: 1 }],
        "2026-07-08",
        13,
        0
      )
    ).toBe(2);
  });

  it("never grows the window and keeps it whole when data spans it", () => {
    expect(
      activeHistoryWeeks(
        [{ date: "2026-01-01", group: "a", value: 1 }],
        "2026-07-08",
        13,
        0
      )
    ).toBe(13);
  });

  it("keeps the full window when there is no data at all (the caller's empty-state call)", () => {
    expect(activeHistoryWeeks([], "2026-07-08", 13, 0)).toBe(13);
  });

  it("ignores zero values and values after end", () => {
    expect(
      activeHistoryWeeks(
        [
          { date: "2026-05-01", group: "a", value: 0 },
          { date: "2026-07-20", group: "a", value: 3 },
          { date: "2026-07-06", group: "a", value: 2 },
        ],
        "2026-07-08",
        13,
        0
      )
    ).toBe(1);
  });
});

describe("buildDayHistoryCalendar", () => {
  const calendarLevel = DAY_HISTORY_DOMAINS.food.calendarLevel;

  it("lays week columns over dayGrid with future padding after end", () => {
    // 2026-07-08 is a Wednesday; with weekStart=0 the last column runs Sun Jul 5
    // – Sat Jul 11, so Thu–Sat are future padding.
    const cal = buildDayHistoryCalendar({
      totals: new Map([
        ["2026-07-06", 3],
        ["2026-07-08", 9],
      ]),
      end: "2026-07-08",
      weeks: 2,
      calendarLevel,
      today: "2026-07-08",
    });
    expect(cal.start).toBe(dayHistoryStart("2026-07-08", 2, 0));
    expect(cal.columns).toHaveLength(2);
    for (const col of cal.columns) expect(col).toHaveLength(7);
    const last = cal.columns[1];
    expect(last.filter((c) => c.future).map((c) => c.date)).toEqual([
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
    const wed = last.find((c) => c.date === "2026-07-08")!;
    expect(wed.value).toBe(9);
    expect(wed.level).toBe(calendarLevel(9));
    expect(wed.today).toBe(true);
    const mon = last.find((c) => c.date === "2026-07-06")!;
    expect(mon.level).toBe(calendarLevel(3));
    expect(cal.activeDays).toBe(2);
    expect(cal.totalValue).toBe(12);
  });

  it("honors a non-Sunday week start", () => {
    const cal = buildDayHistoryCalendar({
      totals: new Map(),
      end: "2026-07-08",
      weeks: 1,
      weekStart: 1,
      calendarLevel,
      today: "2026-07-08",
    });
    // Monday-start week containing Wed Jul 8 begins Mon Jul 6.
    expect(cal.columns[0][0].date).toBe("2026-07-06");
    expect(cal.weekdayOrder[0]).toBe(1);
  });
});

// ---- Week grain (#2413) ----------------------------------------------------
//
// The histories used to CLAMP a year-scale request back to their day cap, so a
// 1Y range rendered the most recent quarter and the range pill did nothing
// above it. The grain now follows the window; these pin the decision, the
// bucketing, and the partial trailing week the decision creates.

describe("dayHistoryWindow — the grain decision", () => {
  // Sun 2026-01-04 … the anchor below is a Wednesday, so every case exercises
  // the week alignment rather than landing on tidy boundaries.
  const to = "2026-08-12";

  it("keeps day grain at and below the cap, passing the lens's own count through", () => {
    // 90D ≈ 13 weeks, exactly the cap: the boundary case stays on day cells.
    const at = dayHistoryWindow({ from: "2026-05-17", to, weeks: 13 });
    expect(at.grain).toBe("day");
    expect(at.weeks).toBe(13);

    const under = dayHistoryWindow({ from: "2026-07-20", to, weeks: 4 });
    expect(under).toEqual({ grain: "day", weeks: 4 });
  });

  it("re-grains STRICTLY above the cap", () => {
    const over = dayHistoryWindow({ from: "2026-05-10", to, weeks: 13 });
    expect(over.grain).toBe("week");
    expect(over.weeks).toBe(14);
  });

  it("reads the UNCLAMPED span, not the clamped week count", () => {
    // This is the whole defect: `weeks` arrives already clamped to 13 by
    // `lensWindow`, so asking IT whether the request exceeded 13 can only ever
    // answer no — which is why 1Y rendered a quarter. The range's own bounds
    // are what decide.
    const year = dayHistoryWindow({ from: "2025-08-13", to, weeks: 13 });
    expect(year.grain).toBe("week");
    expect(year.weeks).toBeGreaterThan(50);
    expect(year.weeks).toBeLessThanOrEqual(MAX_HISTORY_WEEK_COLUMNS);
  });

  it("an all-time window takes week grain at the 53-week cap", () => {
    expect(dayHistoryWindow({ from: null, to, weeks: 13 })).toEqual({
      grain: "week",
      weeks: MAX_HISTORY_WEEK_COLUMNS,
    });
  });

  it("caps a multi-year window at 53 weeks rather than growing without bound", () => {
    const decade = dayHistoryWindow({ from: "2016-01-01", to, weeks: 13 });
    expect(decade.weeks).toBe(MAX_HISTORY_WEEK_COLUMNS);
  });

  it("honours a surface's own day cap when it declares one", () => {
    const wide = dayHistoryWindow({
      from: "2026-05-10",
      to,
      weeks: 14,
      maxDayWeeks: 26,
    });
    expect(wide).toEqual({ grain: "day", weeks: 14 });
    expect(MAX_HISTORY_DAY_WEEKS).toBe(13);
  });

  it("respects the profile's week start when measuring the span", () => {
    // Sun-start and Mon-start disagree about how many weeks a span touches when
    // it begins on a Sunday, and the grain must follow the profile's own weeks.
    const sunday = "2026-05-10";
    expect(
      dayHistoryWindow({ from: sunday, to, weeks: 13, weekStart: 0 }).weeks
    ).not.toBe(
      dayHistoryWindow({ from: sunday, to, weeks: 13, weekStart: 1 }).weeks
    );
  });
});

describe("historyBucket / historyWeeks / historyBuckets", () => {
  it("buckets a date to itself at day grain and to its week start at week grain", () => {
    expect(historyBucket("2026-08-12", "day")).toBe("2026-08-12");
    expect(historyBucket("2026-08-12", "week", 0)).toBe("2026-08-09");
    expect(historyBucket("2026-08-12", "week", 1)).toBe("2026-08-10");
  });

  it("enumerates week starts ascending, including the partial trailing week", () => {
    expect(historyWeeks("2026-07-26", "2026-08-12", 0)).toEqual([
      "2026-07-26",
      "2026-08-02",
      "2026-08-09",
    ]);
  });

  it("aligns a mid-week start back rather than dropping its days", () => {
    // A bucket list that began at the mid-week date would silently disagree
    // with the totals, which bucket every value they are handed.
    expect(historyWeeks("2026-07-29", "2026-08-05", 0)).toEqual([
      "2026-07-26",
      "2026-08-02",
    ]);
  });

  it("historyBuckets is the one list both halves read", () => {
    expect(historyBuckets("2026-08-09", "2026-08-12", "day")).toHaveLength(4);
    expect(historyBuckets("2026-08-09", "2026-08-12", "week", 0)).toEqual([
      "2026-08-09",
    ]);
  });
});

describe("historyBucketCoverage — the partial trailing week", () => {
  it("a complete week covers seven days and is not partial", () => {
    expect(historyBucketCoverage("2026-08-02", "week", "2026-08-12")).toEqual({
      through: "2026-08-08",
      span: "2026-08-08",
      days: 7,
      partial: false,
    });
  });

  it("the LIVE trailing week is partial, and keeps its real span", () => {
    // Wednesday: four days elapsed of the current week. The cell is kept — a
    // trailing trim that ate it would hide the live week — and DECLARED, so a
    // half-elapsed week's smaller total is never read as a decline.
    const live = historyBucketCoverage("2026-08-09", "week", "2026-08-12");
    expect(live.partial).toBe(true);
    expect(live.days).toBe(4);
    expect(live.through).toBe("2026-08-12");
    expect(live.span).toBe("2026-08-15");
  });

  it("a day is never partial", () => {
    const day = historyBucketCoverage("2026-08-12", "day", "2026-08-12");
    expect(day).toEqual({
      through: "2026-08-12",
      span: "2026-08-12",
      days: 1,
      partial: false,
    });
  });
});

describe("bucketWord", () => {
  it("names the unit every bucket count is measured in", () => {
    expect(bucketWord("day")).toEqual({ one: "day", many: "days" });
    expect(bucketWord("week")).toEqual({ one: "week", many: "weeks" });
  });
});

describe("week-grain bucketing through the builders", () => {
  const weekStart = 0;
  const values: DayHistoryValue[] = [
    // Week of 2026-07-26
    { date: "2026-07-27", group: "veg", value: 2 },
    { date: "2026-07-30", group: "veg", value: 1 },
    { date: "2026-07-30", group: "fish", value: 1 },
    // Week of 2026-08-02
    { date: "2026-08-03", group: "veg", value: 3 },
    // Week of 2026-08-09 — the live, partial week
    { date: "2026-08-10", group: "fish", value: 2 },
  ];
  const groups = [
    { key: "veg", label: "Vegetables" },
    { key: "fish", label: "Fish" },
  ];
  const end = "2026-08-12";
  const buckets = historyBuckets("2026-07-26", end, "week", weekStart);

  it("sums a group's whole week into one cell", () => {
    const rows = buildDayHistoryRows({
      days: buckets,
      values,
      groups,
      selected: null,
      maxRows: 8,
      cellLevel: DAY_HISTORY_DOMAINS.food.weekCellLevel,
      today: end,
      grain: "week",
      weekStart,
    });
    const veg = rows.find((r) => r.key === "veg")!;
    expect(veg.cells.map((c) => c.value)).toEqual([3, 3, 0]);
    // `activeDays` counts BUCKETS that carried a value — weeks, here.
    expect(veg.activeDays).toBe(2);
    expect(veg.total).toBe(6);
  });

  it("marks the CURRENT WEEK as today's cell, not the week's first day", () => {
    const rows = buildDayHistoryRows({
      days: buckets,
      values,
      groups,
      selected: null,
      maxRows: 8,
      cellLevel: DAY_HISTORY_DOMAINS.food.weekCellLevel,
      today: end, // a Wednesday
      grain: "week",
      weekStart,
    });
    const marked = rows[0].cells.filter((c) => c.today);
    expect(marked).toHaveLength(1);
    expect(marked[0].date).toBe("2026-08-09");
  });

  it("dayTotals buckets to weeks when asked, and to days otherwise", () => {
    expect(
      dayTotals(values, null, { grain: "week", weekStart })
    ).toEqual(
      new Map([
        ["2026-07-26", 4],
        ["2026-08-02", 3],
        ["2026-08-09", 2],
      ])
    );
    expect(dayTotals(values, null).get("2026-07-30")).toBe(2);
  });

  it("the group filter still applies before bucketing", () => {
    expect(
      dayTotals(values, new Set(["fish"]), { grain: "week", weekStart })
    ).toEqual(
      new Map([
        ["2026-07-26", 1],
        ["2026-08-09", 2],
      ])
    );
  });
});

describe("buildDayHistoryStrip", () => {
  const end = "2026-08-12";
  const totals = new Map([
    ["2026-07-26", 4],
    ["2026-08-09", 2],
  ]);

  const strip = buildDayHistoryStrip({
    totals,
    end,
    weeks: 3,
    weekStart: 0,
    stripLevel: DAY_HISTORY_DOMAINS.food.weekStripLevel,
    today: end,
  });

  it("lays one cell per week, oldest first, on the shared grid", () => {
    expect(strip.cells.map((c) => c.date)).toEqual([
      "2026-07-26",
      "2026-08-02",
      "2026-08-09",
    ]);
    expect(strip.start).toBe(dayHistoryStart(end, 3, 0));
    expect(strip.end).toBe(end);
  });

  it("counts active WEEKS and the window total", () => {
    expect(strip.activeWeeks).toBe(2);
    expect(strip.totalValue).toBe(6);
  });

  it("keeps a quiet week visible rather than compressing it away", () => {
    // The day-fill discipline at week grain: an empty week is a cell, not a
    // missing column, or a two-week gap would render as adjacent weeks.
    expect(strip.cells[1]).toMatchObject({ value: 0, level: 0 });
  });

  it("declares the live trailing week partial and rings it as today", () => {
    const live = strip.cells[2];
    expect(live).toMatchObject({ partial: true, days: 4, today: true });
    expect(live.through).toBe(end);
    expect(live.span).toBe("2026-08-15");
    expect(strip.cells[0].partial).toBe(false);
  });

  it("colors a week by the domain's declared strip ladder", () => {
    const quantity = buildDayHistoryStrip({
      totals: new Map([["2026-07-26", 4]]),
      end,
      weeks: 3,
      weekStart: 0,
      stripLevel: DAY_HISTORY_DOMAINS.workout.weekStripLevel,
      today: end,
    });
    expect(quantity.cells[0].level).toBe(1);
    expect(strip.cells[0].level).toBe(1); // food: coverage, whatever the total
  });

  it("labels the months its weeks open", () => {
    expect(strip.monthLabels).toEqual([
      { col: 0, label: "Jul" },
      { col: 1, label: "Aug" },
    ]);
  });
});
