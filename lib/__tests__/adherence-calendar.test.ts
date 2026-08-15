import { describe, it, expect } from "vitest";
import { buildAdherenceCalendar } from "@/lib/adherence-calendar";
import type { AdherenceDot } from "@/lib/intake-adherence";

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
      pending: 0,
      na: 0,
    });
  });

  it("spans multiple weeks with no leading blank when the range starts on Sunday", () => {
    // 2024-01-07 is a Sunday: 8 contiguous days → two full weeks, first cell is the 7th.
    // (The dates are zero-padded properly here; the old string-slice fixture silently
    // produced five copies of 2024-01-01, which the pre-#2042 "lay dots out in order"
    // builder happened to render as eight sequential cells anyway.)
    const dots: AdherenceDot[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2024-01-${String(7 + i).padStart(2, "0")}`,
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
      counts: {
        taken: 0,
        partial: 0,
        skipped: 0,
        missed: 0,
        pending: 0,
        na: 0,
      },
    });
  });

  it("excludes days before the medication course started", () => {
    const dots: AdherenceDot[] = [
      { date: "2024-01-01", state: "missed" },
      { date: "2024-01-02", state: "missed" },
      { date: "2024-01-03", state: "taken" },
      { date: "2024-01-04", state: "skipped" },
    ];

    const { weeks, counts } = buildAdherenceCalendar(dots, "2024-01-03");
    const realDays = weeks.flat().filter((cell) => cell.date != null);

    expect(realDays).toEqual([
      { date: "2024-01-03", state: "taken" },
      { date: "2024-01-04", state: "skipped" },
    ]);
    expect(counts).toEqual({
      taken: 1,
      partial: 0,
      skipped: 1,
      missed: 0,
      pending: 0,
      na: 0,
    });
  });

  // Today, still pending (#2796). The strip scores an unlogged due day as "missed"
  // because that is all it can say; the calendar was painting today's cell red and
  // "Missed" while the block above it still offered "Mark taken", and counting it in
  // the legend's missed total. Today is unsettled, not failed.
  describe("the trailing pending day", () => {
    const withTrailing = (last: AdherenceDot["state"]): AdherenceDot[] => [
      { date: "2024-01-01", state: "taken" },
      { date: "2024-01-02", state: "taken" },
      { date: "2024-01-03", state: last },
    ];

    it("renders today's unresolved cell as pending, not missed", () => {
      const { weeks, counts } = buildAdherenceCalendar(withTrailing("missed"));
      const realDays = weeks.flat().filter((cell) => cell.date != null);

      // The cell is still THERE — dropping it (what the percentage does) would put a
      // hole in the month grid where today should be.
      expect(realDays).toHaveLength(3);
      expect(realDays[2]).toEqual({ date: "2024-01-03", state: "pending" });
      expect(counts.missed).toBe(0);
      expect(counts.pending).toBe(1);
    });

    it("leaves an EARLIER missed day alone", () => {
      const dots: AdherenceDot[] = [
        { date: "2024-01-01", state: "missed" },
        { date: "2024-01-02", state: "missed" },
        { date: "2024-01-03", state: "taken" },
      ];
      const { counts } = buildAdherenceCalendar(dots);
      // A real lapse two days ago is settled and stays counted. Only the trailing day
      // is unresolved — a guard that swallowed every miss would be worse than the bug.
      expect(counts.missed).toBe(2);
      expect(counts.pending).toBe(0);
    });

    for (const state of ["taken", "skipped", "partial", "na"] as const) {
      it(`leaves a trailing "${state}" day alone`, () => {
        const { counts } = buildAdherenceCalendar(withTrailing(state));
        expect(counts.pending).toBe(0);
        expect(counts[state]).toBe(state === "taken" ? 3 : 1);
      });
    }

    it("reads the pending day off the VISIBLE window, after the course-start trim", () => {
      // The startedOn filter trims from the front only, so the trailing day is the
      // same day either way — pinned because a filter that ever trimmed the tail
      // would silently move which day is called pending.
      const dots: AdherenceDot[] = [
        { date: "2024-01-01", state: "missed" },
        { date: "2024-01-02", state: "taken" },
        { date: "2024-01-03", state: "missed" },
      ];
      const { counts } = buildAdherenceCalendar(dots, "2024-01-02");
      expect(counts.missed).toBe(0);
      expect(counts.pending).toBe(1);
      expect(counts.taken).toBe(1);
    });
  });
});
