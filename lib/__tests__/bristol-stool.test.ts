// PURE TIER — the Bristol stool-form vocabulary, its guard, and the panel builder
// (issue #2785).
//
// Two things here are load-bearing rather than descriptive:
//
//   1. THE VOCABULARY IS THE GUARD. `isBristolType` asks whether a number is a MEMBER
//      of the scale, not whether it falls in a range, so 0, 8, 3.5, NaN and "4" are all
//      refused by one question. A range comparison written out at three call sites is
//      three chances to write `>= 0`, and it lets a 3.5 through while naming no type.
//   2. THE BUILDER COUNTS AND NEVER AVERAGES. A day holding type 1 and type 7 must stay
//      two observations. Their mean is 4 — the middle of the scale — so an averaging
//      builder would render the week that most needs to be visible as textbook-normal.

import { describe, it, expect } from "vitest";
import {
  BRISTOL_PANEL_DAYS,
  BRISTOL_STOOL_METRIC,
  BRISTOL_STOOL_TYPES,
  MAX_BRISTOL_TYPE,
  MIN_BRISTOL_TYPE,
  bristolPanelDates,
  bristolStoolType,
  buildBristolPanel,
  isBristolType,
  parseBristolType,
} from "@/lib/bristol-stool";

describe("the scale", () => {
  it("is types 1-7 in order, each with a label and the scale's description", () => {
    expect(BRISTOL_STOOL_TYPES.map((t) => t.type)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(MIN_BRISTOL_TYPE).toBe(1);
    expect(MAX_BRISTOL_TYPE).toBe(7);
    for (const t of BRISTOL_STOOL_TYPES) {
      expect(t.label.trim().length, `type ${t.type}`).toBeGreaterThan(0);
      // The description is the accessible name of a button, so it has to say
      // something — a repeated label would leave a screen reader with "Type 3, 3".
      expect(t.description.trim().length, `type ${t.type}`).toBeGreaterThan(
        t.label.length
      );
    }
    // Distinct captions: seven buttons a person picks BETWEEN, so two reading the
    // same is the one failure that makes the picker unusable.
    const labels = BRISTOL_STOOL_TYPES.map((t) => t.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names its store key once, where every writer and reader takes it from", () => {
    expect(BRISTOL_STOOL_METRIC).toBe("bristol_stool_type");
  });
});

describe("isBristolType — the ONE guard", () => {
  it("accepts exactly the seven types", () => {
    for (const t of BRISTOL_STOOL_TYPES)
      expect(isBristolType(t.type)).toBe(true);
  });

  it("refuses the values a range check would let through or mis-handle", () => {
    // The two the issue names by number.
    expect(isBristolType(0)).toBe(false);
    expect(isBristolType(8)).toBe(false);
    // Inside the range and still not a type — the case `>= 1 && <= 7` passes.
    expect(isBristolType(3.5)).toBe(false);
    expect(isBristolType(6.999)).toBe(false);
    // Outside it in every other direction.
    expect(isBristolType(-1)).toBe(false);
    expect(isBristolType(70)).toBe(false);
    expect(isBristolType(NaN)).toBe(false);
    expect(isBristolType(Infinity)).toBe(false);
    // Not numbers at all: a form field arrives as a string, and a guard that
    // coerced would accept "4" here and then store a string.
    expect(isBristolType("4")).toBe(false);
    expect(isBristolType(null)).toBe(false);
    expect(isBristolType(undefined)).toBe(false);
    expect(isBristolType({ type: 4 })).toBe(false);
  });

  it("bristolStoolType answers with the entry, or null for a non-type", () => {
    expect(bristolStoolType(4)?.label).toBe(BRISTOL_STOOL_TYPES[3].label);
    expect(bristolStoolType(0)).toBeNull();
    expect(bristolStoolType(8)).toBeNull();
    expect(bristolStoolType(3.5)).toBeNull();
  });
});

describe("parseBristolType — the form-field door", () => {
  it("takes the seven types as numbers or as the strings a FormData carries", () => {
    expect(parseBristolType(1)).toBe(1);
    expect(parseBristolType("7")).toBe(7);
    expect(parseBristolType(" 4 ")).toBe(4);
    // A whole number spelled with a decimal point is still that type.
    expect(parseBristolType("4.0")).toBe(4);
  });

  it("refuses everything else, so a crafted post cannot store a non-type", () => {
    for (const raw of [
      "0",
      "8",
      "3.5",
      "-2",
      "",
      "   ",
      "four",
      null,
      undefined,
      {},
      [],
    ]) {
      expect(parseBristolType(raw), String(raw)).toBeNull();
    }
  });
});

describe("buildBristolPanel", () => {
  const DATES = bristolPanelDates("2026-08-28");

  it("spans four whole weeks, oldest → newest", () => {
    expect(DATES).toHaveLength(BRISTOL_PANEL_DAYS);
    expect(BRISTOL_PANEL_DAYS % 7).toBe(0);
    expect(DATES[0]).toBe("2026-08-01");
    expect(DATES[DATES.length - 1]).toBe("2026-08-28");
  });

  it("keeps a day's readings SEPARATE and never averages them", () => {
    // The load-bearing case. A day holding the two extremes averages to 4 — the
    // middle of the scale — so a builder that collapsed the day would report the
    // worst week in the window as textbook-normal.
    const panel = buildBristolPanel(DATES, [
      { date: "2026-08-10", type: 1 },
      { date: "2026-08-10", type: 7 },
    ]);
    const day = panel.days.find((d) => d.date === "2026-08-10")!;
    expect(day.types).toEqual([1, 7]);
    expect(panel.total).toBe(2);
    // Both extremes counted once; nothing landed on type 4.
    const count = (t: number) =>
      panel.distribution.find((d) => d.type === t)!.count;
    expect(count(1)).toBe(1);
    expect(count(7)).toBe(1);
    expect(count(4)).toBe(0);
  });

  it("renders a day with no reading as a HOLE, distinguishable from a logged one", () => {
    const panel = buildBristolPanel(DATES, [{ date: "2026-08-10", type: 4 }]);
    expect(panel.days).toHaveLength(BRISTOL_PANEL_DAYS);
    expect(panel.days.find((d) => d.date === "2026-08-09")!.types).toEqual([]);
    expect(panel.days.find((d) => d.date === "2026-08-10")!.types).toEqual([4]);
  });

  it("carries every type in the distribution, zeroes included", () => {
    const panel = buildBristolPanel(DATES, [{ date: "2026-08-10", type: 4 }]);
    expect(panel.distribution.map((d) => d.type)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(panel.distribution.filter((d) => d.count === 0)).toHaveLength(6);
    expect(panel.maxCount).toBe(1);
  });

  it("drops a row outside the vocabulary, so no eighth bar can be drawn", () => {
    // A hand-edited or replayed row carrying a 0 or an 8 must not reach a surface.
    const panel = buildBristolPanel(DATES, [
      { date: "2026-08-10", type: 0 },
      { date: "2026-08-10", type: 8 },
      { date: "2026-08-10", type: 3.5 },
      { date: "2026-08-10", type: 3 },
    ]);
    expect(panel.days.find((d) => d.date === "2026-08-10")!.types).toEqual([3]);
    expect(panel.total).toBe(1);
    expect(panel.distribution).toHaveLength(7);
  });

  it("ignores a reading outside the window", () => {
    const panel = buildBristolPanel(DATES, [
      { date: "2026-07-31", type: 2 },
      { date: "2026-08-29", type: 2 },
    ]);
    expect(panel.total).toBe(0);
    // An empty window still has a fixed shape and a non-zero scale divisor.
    expect(panel.days).toHaveLength(BRISTOL_PANEL_DAYS);
    expect(panel.maxCount).toBe(1);
  });
});
