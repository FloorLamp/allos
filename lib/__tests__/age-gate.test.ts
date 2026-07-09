import { describe, it, expect } from "vitest";
import { parseMinAge } from "../age-gate";

// parseMinAge() is the pure threshold parser; minTrainingAge()/isTrainingRestricted()
// layer a DB read on top, so only the pure half is unit tested here (the suite is
// DB-free by convention).
describe("parseMinAge", () => {
  it("returns null for null / undefined (gate disabled)", () => {
    expect(parseMinAge(null)).toBeNull();
    expect(parseMinAge(undefined)).toBeNull();
  });

  it("returns null for a blank / whitespace value", () => {
    expect(parseMinAge("")).toBeNull();
    expect(parseMinAge("   ")).toBeNull();
  });

  it("parses a whole-number age", () => {
    expect(parseMinAge("18")).toBe(18);
    expect(parseMinAge("  18  ")).toBe(18);
  });

  it("floors a fractional value", () => {
    expect(parseMinAge("17.9")).toBe(17);
  });

  it("returns null for zero, negatives, and non-numbers", () => {
    expect(parseMinAge("0")).toBeNull();
    expect(parseMinAge("-5")).toBeNull();
    expect(parseMinAge("abc")).toBeNull();
  });
});
