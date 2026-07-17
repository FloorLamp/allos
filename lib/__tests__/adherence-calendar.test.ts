import { describe, it, expect } from "vitest";
import { buildAdherenceCalendar } from "@/lib/adherence-calendar";
import type { AdherenceDot } from "@/lib/supplement-adherence";

describe("buildAdherenceCalendar (#852 item 5)", () => {
  it("pads to whole Sun→Sat weeks and preserves each day's state", () => {
    // 2024-01-01 is a Monday (UTC weekday 1), so the first week gets ONE leading blank.
    const dots: AdherenceDot[] = [
      { date: "2024-01-01", state: "taken" }, // Mon
      { date: "2024-01-02", state: "missed" }, // Tue
      { date: "2024-01-03", state: "skipped" }, // Wed
    ];
    const { weeks, counts } = buildAdherenceCalendar(dots);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toHaveLength(7);
    // Sunday blank, then the three days, then trailing blanks.
    expect(weeks[0][0]).toEqual({ date: null, state: null });
    expect(weeks[0][1]).toEqual({ date: "2024-01-01", state: "taken" });
    expect(weeks[0][2]).toEqual({ date: "2024-01-02", state: "missed" });
    expect(weeks[0][3]).toEqual({ date: "2024-01-03", state: "skipped" });
    expect(weeks[0][4]).toEqual({ date: null, state: null });
    expect(counts).toEqual({
      taken: 1,
      partial: 0,
      skipped: 1,
      missed: 1,
      na: 0,
    });
  });

  it("spans multiple weeks with no leading blank when the range starts on Sunday", () => {
    // 2024-01-07 is a Sunday: 8 contiguous days → two full weeks, first cell is the 7th.
    const dots: AdherenceDot[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2024-01-0${7 + i}`.slice(0, 10),
      state: "na" as const,
    }));
    const { weeks } = buildAdherenceCalendar(dots);
    expect(weeks).toHaveLength(2);
    expect(weeks[0][0]).toEqual({ date: "2024-01-07", state: "na" });
    expect(weeks[1][1]).toEqual({ date: null, state: null }); // trailing pad
  });

  it("returns an empty grid for no data", () => {
    expect(buildAdherenceCalendar([])).toEqual({
      weeks: [],
      counts: { taken: 0, partial: 0, skipped: 0, missed: 0, na: 0 },
    });
  });
});
