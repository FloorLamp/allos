import { describe, it, expect } from "vitest";
import {
  PLATE_DENOMINATIONS,
  STANDARD_BAR_WEIGHT,
  MAX_PLATES_PER_SIDE,
  platesForWeight,
  platesPerSideWeight,
  barbellTotal,
} from "@/lib/plates";

// Pure barbell plate-loading math (issue #314), extracted from PlateBuilderModal.

describe("policy constants", () => {
  it("kg denominations descend from 25 and the bar is 20 kg", () => {
    expect(PLATE_DENOMINATIONS.kg[0]).toBe(25);
    expect(STANDARD_BAR_WEIGHT.kg).toBe(20);
  });
  it("lb denominations descend from 45 and the bar is 45 lb", () => {
    expect(PLATE_DENOMINATIONS.lb[0]).toBe(45);
    expect(STANDARD_BAR_WEIGHT.lb).toBe(45);
  });
  it("caps at 10 plates per side", () => {
    expect(MAX_PLATES_PER_SIDE).toBe(10);
  });
});

describe("platesForWeight — greedy largest-first fill", () => {
  it("loads a clean kg target exactly", () => {
    // (100 - 20) / 2 = 40 per side → 25 + 15.
    expect(platesForWeight(100, 20, "kg")).toEqual([25, 15]);
  });

  it("loads the classic 2-plate lb bench (225 on a 45 lb bar)", () => {
    // (225 - 45) / 2 = 90 per side → 45 + 45.
    expect(platesForWeight(225, 45, "lb")).toEqual([45, 45]);
  });

  it("loads a fractional-but-loadable target using the small plates", () => {
    // (102.5 - 20) / 2 = 41.25 → 25 + 15 + 1.25 (no float drift).
    expect(platesForWeight(102.5, 20, "kg")).toEqual([25, 15, 1.25]);
  });

  it("drops an unloadable remainder finer than the smallest plate (never overshoots)", () => {
    // (101 - 20) / 2 = 40.5 → 25 + 15, leaving 0.5 kg unloadable.
    const plates = platesForWeight(101, 20, "kg");
    expect(plates).toEqual([25, 15]);
    expect(barbellTotal(20, plates)).toBeLessThanOrEqual(101);
  });

  it("returns nothing for a sub-bar target", () => {
    expect(platesForWeight(15, 20, "kg")).toEqual([]);
  });

  it("returns nothing when the target equals the bar", () => {
    expect(platesForWeight(20, 20, "kg")).toEqual([]);
  });

  it("honors the per-side plate cap for an enormous target", () => {
    const plates = platesForWeight(100000, 20, "kg");
    expect(plates).toHaveLength(MAX_PLATES_PER_SIDE);
    expect(plates.every((p) => p === 25)).toBe(true);
  });

  it("fills repeated fractional plates without drift", () => {
    // (27.5 - 20) / 2 = 3.75 → 2.5 + 1.25.
    expect(platesForWeight(27.5, 20, "kg")).toEqual([2.5, 1.25]);
  });

  it("never overshoots the target across a sweep of odd weights", () => {
    for (let target = 20; target <= 500; target += 0.25) {
      const total = barbellTotal(20, platesForWeight(target, 20, "kg"));
      expect(total).toBeLessThanOrEqual(target + 1e-9);
    }
  });
});

describe("platesPerSideWeight — drift-free per-side sum", () => {
  it("sums fractional plates cleanly", () => {
    expect(platesPerSideWeight([1.25, 2.5])).toBe(3.75);
    expect(platesPerSideWeight([1.25, 1.25, 1.25])).toBe(3.75);
  });
  it("is zero for an empty side", () => {
    expect(platesPerSideWeight([])).toBe(0);
  });
});

describe("barbellTotal — bar + 2 × per side", () => {
  it("doubles the per-side plates onto the bar", () => {
    expect(barbellTotal(20, [25, 15])).toBe(100);
    expect(barbellTotal(45, [45, 45])).toBe(225);
  });
  it("is just the bar with no plates", () => {
    expect(barbellTotal(20, [])).toBe(20);
  });
  it("stays drift-free with repeated fractional plates", () => {
    expect(barbellTotal(20, [1.25, 2.5, 1.25])).toBe(30);
  });
});
