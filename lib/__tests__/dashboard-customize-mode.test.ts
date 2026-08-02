import { describe, expect, it } from "vitest";
import { dashboardCustomizeMode } from "@/lib/dashboard-widgets";

// The one question Customize asks about the viewport (#1891): "is this grid
// actually multi-column here?" — and the two things that follow from the single
// answer. Pure, so the phone editor's presentation and its drag strategy can be
// asserted without a browser, and so they cannot drift apart.
describe("dashboardCustomizeMode", () => {
  it("edits in place, in two dimensions, on a wide grid", () => {
    expect(dashboardCustomizeMode(true)).toEqual({
      compact: false,
      strategy: "rect",
    });
  });

  it("collapses to a vertical list of reorder rows below lg", () => {
    expect(dashboardCustomizeMode(false)).toEqual({
      compact: true,
      strategy: "vertical",
    });
  });

  // The pairing is the point: a compact single-column list sorted with the RECT
  // strategy is the bug this issue is about, and a wide wrapped grid sorted
  // vertically would move the wrong neighbours. One reading, one decision.
  it("never pairs a compact list with a rect sort, or a card grid with a vertical one", () => {
    for (const wide of [true, false]) {
      const { compact, strategy } = dashboardCustomizeMode(wide);
      expect(strategy).toBe(compact ? "vertical" : "rect");
    }
  });
});
