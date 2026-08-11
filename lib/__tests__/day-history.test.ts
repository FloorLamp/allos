import { describe, expect, it } from "vitest";
import {
  DAY_HISTORY_DOMAINS,
  FOLDED_ROW_KEY,
  activeHistoryWeeks,
  buildDayHistoryCalendar,
  buildDayHistoryRows,
  dayHistoryStart,
  dayTotals,
  historyDays,
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
    }
  });

  it("levels are 0 exactly at zero and monotonic over rising values", () => {
    for (const key of keys) {
      const spec = DAY_HISTORY_DOMAINS[key];
      for (const level of [spec.calendarLevel, spec.cellLevel]) {
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
