import { describe, it, expect } from "vitest";
import {
  measurementsSavedText,
  validateBodyMetricInput,
  MAX_PLAUSIBLE_WEIGHT,
} from "@/lib/body-metric-input";
import {
  STATED_TIME_REFUSAL_NOTE,
  type StatedTimeRefusal,
} from "@/lib/stated-time";

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

  it("allows standalone body-fat and resting-HR detail entries", () => {
    expect(
      validateBodyMetricInput(
        { weight: null, bodyFatPct: "18.5", restingHr: null },
        { requireWeight: false }
      )
    ).toBeNull();
    expect(
      validateBodyMetricInput(
        { weight: null, bodyFatPct: null, restingHr: "54" },
        { requireWeight: false }
      )
    ).toBeNull();
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

// #2311 — what the measurements form SAYS when the sitting's stated time did not
// survive the acceptance gate. The reading landed either way; the sentence is the
// whole fix, so it is pinned rather than left to a JSX handler.
describe("measurementsSavedText", () => {
  it("says only what was saved when nothing was refused", () => {
    expect(measurementsSavedText("Measurements saved")).toBe(
      "Measurements saved"
    );
    // `unstated` and `accepted` are BOTH silence here: only a refusal is news.
    expect(measurementsSavedText("Weight saved", undefined)).toBe(
      "Weight saved"
    );
  });

  it("amends the SAME success sentence with the rule that fired", () => {
    expect(measurementsSavedText("Measurements saved", "future")).toBe(
      "Measurements saved without the time — that time hasn't happened yet."
    );
    expect(measurementsSavedText("Weight saved", "other-day")).toBe(
      "Weight saved without the time — it isn't on that day."
    );
    expect(measurementsSavedText("Measurements saved", "malformed")).toBe(
      "Measurements saved without the time — it couldn't be read."
    );
  });

  it("has a clause for every reason, and never diagnoses the user's device", () => {
    const reasons: StatedTimeRefusal[] = ["future", "other-day", "malformed"];
    for (const reason of reasons) {
      const sentence = measurementsSavedText("Measurements saved", reason);
      // Completeness: a new refusal reason cannot ship here as bare silence.
      expect(sentence).not.toBe("Measurements saved");
      // The measurements Time is a field the user SEES — typed, or filled by the
      // control's one-tap "Now" — so this surface must never answer a future
      // instant with "your device's clock is ahead" (#2296's rule about which
      // vocabulary belongs where). The other two clauses are about the STATEMENT
      // rather than the machine, and legitimately read the same on both surfaces.
      expect(sentence).not.toContain(STATED_TIME_REFUSAL_NOTE.future);
    }
  });
});
