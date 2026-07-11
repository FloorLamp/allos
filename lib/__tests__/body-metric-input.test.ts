import { describe, it, expect } from "vitest";
import {
  validateBodyMetricInput,
  MAX_PLAUSIBLE_WEIGHT,
} from "@/lib/body-metric-input";

describe("validateBodyMetricInput", () => {
  const ok = { weight: "80", bodyFatPct: null, restingHr: null };

  it("accepts a valid weight-only entry", () => {
    expect(validateBodyMetricInput(ok)).toBeNull();
  });

  it("accepts valid optional fields", () => {
    expect(
      validateBodyMetricInput({
        weight: "80.5",
        bodyFatPct: "18",
        restingHr: "55",
      })
    ).toBeNull();
  });

  it("treats blank/whitespace optional fields as absent", () => {
    expect(
      validateBodyMetricInput({ weight: "80", bodyFatPct: "  ", restingHr: "" })
    ).toBeNull();
  });

  it("rejects a missing weight", () => {
    expect(validateBodyMetricInput({ ...ok, weight: "" })).toMatch(/weight/i);
    expect(validateBodyMetricInput({ ...ok, weight: null })).toMatch(/weight/i);
  });

  it("rejects a non-numeric or non-positive weight", () => {
    expect(validateBodyMetricInput({ ...ok, weight: "abc" })).toMatch(
      /weight/i
    );
    expect(validateBodyMetricInput({ ...ok, weight: "0" })).toMatch(/weight/i);
    expect(validateBodyMetricInput({ ...ok, weight: "-5" })).toMatch(/weight/i);
  });

  it("rejects body fat outside 0-100", () => {
    expect(validateBodyMetricInput({ ...ok, bodyFatPct: "150" })).toMatch(
      /body fat/i
    );
    expect(validateBodyMetricInput({ ...ok, bodyFatPct: "-1" })).toMatch(
      /body fat/i
    );
    expect(validateBodyMetricInput({ ...ok, bodyFatPct: "0" })).toBeNull();
    expect(validateBodyMetricInput({ ...ok, bodyFatPct: "100" })).toBeNull();
  });

  it("rejects a non-positive or implausibly high resting HR", () => {
    expect(validateBodyMetricInput({ ...ok, restingHr: "0" })).toMatch(/hr/i);
    expect(validateBodyMetricInput({ ...ok, restingHr: "-5" })).toMatch(/hr/i);
    expect(validateBodyMetricInput({ ...ok, restingHr: "500" })).toMatch(/hr/i);
    expect(validateBodyMetricInput({ ...ok, restingHr: "60" })).toBeNull();
  });

  it("rejects an impossibly high weight (entry error) but accepts a real one", () => {
    // Impossible in either unit (heaviest human ever ~635 kg / ~1400 lb).
    expect(
      validateBodyMetricInput({
        ...ok,
        weight: String(MAX_PLAUSIBLE_WEIGHT + 1),
      })
    ).toMatch(/too high/i);
    expect(validateBodyMetricInput({ ...ok, weight: "8000" })).toMatch(
      /too high/i
    );
    // A real weigh-in — heavy but plausible — passes.
    expect(
      validateBodyMetricInput({ ...ok, weight: String(MAX_PLAUSIBLE_WEIGHT) })
    ).toBeNull();
    expect(validateBodyMetricInput({ ...ok, weight: "300" })).toBeNull();
  });

  it("reports the weight error first when multiple fields are invalid", () => {
    expect(
      validateBodyMetricInput({
        weight: "",
        bodyFatPct: "150",
        restingHr: "0",
      })
    ).toMatch(/weight/i);
  });
});
