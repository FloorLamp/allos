import { describe, it, expect } from "vitest";
import {
  parseMinAge,
  isDurationActivityType,
  isActivityTypeAllowed,
  DURATION_ACTIVITY_TYPES,
} from "../age-gate";

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

// Type-aware training restriction (#489): the activity DOMAIN (duration-based
// sport/cardio) is age-neutral and survives the gate; only the adult-framed
// STRENGTH domain is blocked. Pure — the write boundary and the UI read this rule.
describe("isDurationActivityType", () => {
  it("treats sport and cardio as duration-based (age-neutral)", () => {
    expect(isDurationActivityType("sport")).toBe(true);
    expect(isDurationActivityType("cardio")).toBe(true);
    expect(DURATION_ACTIVITY_TYPES).toEqual(["cardio", "sport"]);
  });

  it("treats strength as the adult-framed domain (not duration-based)", () => {
    expect(isDurationActivityType("strength")).toBe(false);
  });
});

describe("isActivityTypeAllowed", () => {
  it("allows every type when the profile is not restricted", () => {
    expect(isActivityTypeAllowed("strength", false)).toBe(true);
    expect(isActivityTypeAllowed("sport", false)).toBe(true);
    expect(isActivityTypeAllowed("cardio", false)).toBe(true);
  });

  it("allows only sport/cardio, never strength, when restricted", () => {
    expect(isActivityTypeAllowed("sport", true)).toBe(true);
    expect(isActivityTypeAllowed("cardio", true)).toBe(true);
    expect(isActivityTypeAllowed("strength", true)).toBe(false);
  });
});
