import { describe, expect, it } from "vitest";
import {
  dayGrid,
  dayGridMonthLabels,
  gridStartFor,
  weekSpan,
} from "../day-grid";
import { buildDayHistoryCalendar, dayHistoryStart } from "../day-history";
import { intensityLevel } from "../workout-heatmap";
import { buildProtocolHeatmap } from "../protocol-heatmap";
import { buildAdherenceCalendar } from "../adherence-calendar";

// The ONE grid builder (#2042) that the workout heatmap, the protocol heatmap and
// the month adherence calendar are now adapters over. Each block below covers the
// case that used to justify one of the three separate implementations.

describe("dayGrid", () => {
  it("lays every week as exactly 7 consecutive days from the week start", () => {
    const grid = dayGrid({ start: "2026-03-02", end: "2026-03-15" });
    expect(grid.weekCount).toBe(3); // Mar 2 is a Monday, so the grid opens Mar 1
    expect(grid.gridStart).toBe("2026-03-01");
    expect(grid.weeks).toHaveLength(3);
    for (const week of grid.weeks) expect(week).toHaveLength(7);
    expect(grid.weeks[0].map((c) => c.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
    expect(grid.gridEnd).toBe("2026-03-21");
  });

  it("tags padding on BOTH sides — one vocabulary for future/outside/null", () => {
    const grid = dayGrid({ start: "2026-03-02", end: "2026-03-15" });
    expect(grid.weeks[0][0].position).toBe("before"); // Mar 1, before the window
    expect(grid.weeks[0][1].position).toBe("in-window"); // Mar 2
    expect(grid.weeks[2][0].position).toBe("in-window"); // Mar 15
    expect(grid.weeks[2][1].position).toBe("after"); // Mar 16
    // Padding still carries its real date; only the caller decides to blank it.
    expect(grid.weeks[2][6].date).toBe("2026-03-21");
  });

  it("honors the profile's first weekday", () => {
    const sunday = dayGrid({ start: "2026-03-04", end: "2026-03-04" });
    expect(sunday.gridStart).toBe("2026-03-01");
    const monday = dayGrid({
      start: "2026-03-04",
      end: "2026-03-04",
      weekStart: 1,
    });
    expect(monday.gridStart).toBe("2026-03-02");
  });

  it("truncates from the FRONT, keeping the most recent weeks", () => {
    const grid = dayGrid({
      start: "2024-01-01",
      end: "2026-03-15",
      maxWeeks: 53,
    });
    expect(grid.truncated).toBe(true);
    expect(grid.weekCount).toBe(53);
    expect(grid.gridStart).toBe(gridStartFor("2026-03-15", 53));
    // The window opens later than the grid, so the visible start is the grid's.
    expect(grid.visibleStart).toBe(grid.gridStart);
    expect(grid.weeks[52].some((c) => c.date === "2026-03-15")).toBe(true);
  });

  it("leaves an untruncated grid's visible start at the window's start", () => {
    const grid = dayGrid({
      start: "2026-03-02",
      end: "2026-03-15",
      maxWeeks: 53,
    });
    expect(grid.truncated).toBe(false);
    expect(grid.visibleStart).toBe("2026-03-02");
  });

  it("never returns fewer than one week, even for a backwards window", () => {
    expect(weekSpan("2026-03-15", "2026-03-01")).toBe(1);
    expect(dayGrid({ start: "2026-03-15", end: "2026-03-01" }).weekCount).toBe(
      1
    );
  });

  it("echoes the orientation the caller renders on", () => {
    expect(
      dayGrid({ start: "2026-03-01", end: "2026-03-07" }).orientation
    ).toBe("week-columns");
    expect(
      dayGrid({
        start: "2026-03-01",
        end: "2026-03-07",
        orientation: "week-rows",
      }).orientation
    ).toBe("week-rows");
  });

  it("labels the first week that enters a new month, once each", () => {
    const grid = dayGrid({ start: "2026-01-01", end: "2026-03-15" });
    const labels = dayGridMonthLabels(grid);
    expect(labels.map((l) => l.label)).toEqual(["Dec", "Jan", "Feb", "Mar"]);
    expect(labels[0].col).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The three adapters still answer what they answered before
// ---------------------------------------------------------------------------

describe("the builders over the shared grid", () => {
  it("day-history calendar: `future` is the grid's trailing padding, and nothing else", () => {
    // 2026-03-11 is a Wednesday, so the last column runs three days past it.
    const cal = buildDayHistoryCalendar({
      totals: new Map([["2026-03-10", 2]]),
      end: "2026-03-11",
      weeks: 4,
      calendarLevel: intensityLevel,
      today: "2026-03-11",
    });
    expect(cal.columns).toHaveLength(4);
    expect(cal.start).toBe(dayHistoryStart("2026-03-11", 4));
    const future = cal.columns.flat().filter((c) => c.future);
    expect(future.map((c) => c.date)).toEqual([
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ]);
    // A day-history grid opens exactly on a week boundary, so it has no LEADING pad.
    expect(cal.columns[0][0].date).toBe(cal.start);
    expect(cal.totalValue).toBe(2);
    expect(cal.activeDays).toBe(1);
  });

  it("protocol heatmap: `outside` covers padding before the start AND after the end", () => {
    const hm = buildProtocolHeatmap(
      [
        { date: "2026-03-02", count: 1 },
        { date: "2026-03-20", count: 5 }, // past the window's end — never counted
      ],
      "2026-03-02",
      "2026-03-11"
    );
    expect(hm.columns[0][0]).toMatchObject({
      date: "2026-03-01",
      outside: true,
      count: 0,
    });
    expect(hm.columns[0][1]).toMatchObject({
      date: "2026-03-02",
      outside: false,
      count: 1,
    });
    const last = hm.columns[hm.columns.length - 1];
    expect(last[last.length - 1].outside).toBe(true);
    expect(hm.totalSessions).toBe(1);
    expect(hm.visibleStart).toBe("2026-03-02");
  });

  it("adherence calendar: padding is `null`, rows are Sun→Sat, dates are kept", () => {
    const { weeks } = buildAdherenceCalendar([
      { date: "2026-03-04", state: "taken" },
      { date: "2026-03-05", state: "missed" },
    ]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toHaveLength(7);
    expect(weeks[0][0]).toEqual({ date: null, state: null }); // Sun Mar 1, before
    expect(weeks[0][3]).toEqual({ date: "2026-03-04", state: "taken" });
    expect(weeks[0][4]).toEqual({ date: "2026-03-05", state: "missed" });
    expect(weeks[0][6]).toEqual({ date: null, state: null }); // Sat Mar 7, after
  });
});
