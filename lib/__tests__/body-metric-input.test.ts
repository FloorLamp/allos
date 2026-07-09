import { describe, it, expect } from "vitest";
import { validateBodyMetricInput } from "@/lib/body-metric-input";

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
