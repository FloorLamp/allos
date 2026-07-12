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
    // "workout" is a substring of both "Log workout" and "Start workout" (#340).
    const ids = matchPaletteActions("workout").map((a) => a.id);
    expect(ids).toEqual(["log-workout", "start-workout"]);
    // The more specific labels disambiguate.
    expect(matchPaletteActions("log workout").map((a) => a.id)).toEqual([
      "log-workout",
    ]);
    expect(matchPaletteActions("start").map((a) => a.id)).toEqual([
      "start-workout",
    ]);
  });

  it("offers a live 'Start workout' action (#340)", () => {
    const live = PALETTE_ACTIONS.find((a) => a.id === "start-workout");
    expect(live?.target.kind).toBe("live");
    // Reachable by its in-gym keywords.
    expect(matchPaletteActions("rest timer").map((a) => a.id)).toEqual([
      "start-workout",
    ]);
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

  it("offers a repeat-last action that matches 'again' but not 'workout' (#337)", () => {
    expect(matchPaletteActions("again").map((a) => a.id)).toEqual([
      "repeat-last",
    ]);
    // The repeat action must not collide with the workout-label matches.
    expect(matchPaletteActions("workout").map((a) => a.id)).toEqual([
      "log-workout",
      "start-workout",
    ]);
    const repeat = PALETTE_ACTIONS.find((a) => a.id === "repeat-last");
    expect(repeat?.target.kind).toBe("repeat");
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
