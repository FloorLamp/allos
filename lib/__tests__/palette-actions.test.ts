import { describe, it, expect } from "vitest";
import {
  PALETTE_ACTIONS,
  matchPaletteActions,
  FOCUS_PARAM,
} from "@/lib/palette-actions";

describe("palette create actions", () => {
  it("returns every action for an empty query", () => {
    expect(matchPaletteActions("")).toHaveLength(PALETTE_ACTIONS.length);
    expect(matchPaletteActions("   ")).toHaveLength(PALETTE_ACTIONS.length);
  });

  it("matches on the label", () => {
    const ids = matchPaletteActions("workout").map((a) => a.id);
    expect(ids).toEqual(["log-workout"]);
  });

  it("matches on keywords, case-insensitively", () => {
    expect(matchPaletteActions("gym").map((a) => a.id)).toEqual([
      "log-workout",
    ]);
    expect(matchPaletteActions("LAB").map((a) => a.id)).toEqual([
      "add-biomarker",
    ]);
    expect(matchPaletteActions("doctor").map((a) => a.id)).toEqual([
      "add-appointment",
    ]);
  });

  it("returns nothing for an unrelated query", () => {
    expect(matchPaletteActions("zzzzz")).toEqual([]);
  });

  it("has exactly one in-place activity action; the rest navigate with the focus param", () => {
    const activity = PALETTE_ACTIONS.filter(
      (a) => a.target.kind === "activity"
    );
    expect(activity.map((a) => a.id)).toEqual(["log-workout"]);
    for (const a of PALETTE_ACTIONS) {
      if (a.target.kind === "navigate") {
        expect(a.target.href).toContain(`${FOCUS_PARAM}=`);
      }
    }
  });
});
