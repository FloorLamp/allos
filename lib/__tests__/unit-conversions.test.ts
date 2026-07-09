import { describe, expect, it } from "vitest";
import {
  convertToCanonical,
  isBareCountPerVolume,
  isConvertible,
  sameUnit,
} from "@/lib/unit-conversions";

describe("sameUnit", () => {
  it("treats a missing unit on either side as a match (can't prove a mismatch)", () => {
    expect(sameUnit(null, "mg/dL")).toBe(true);
    expect(sameUnit("mg/dL", undefined)).toBe(true);
    expect(sameUnit(null, null)).toBe(true);
  });

  it("collapses functionally identical concentration units", () => {
    // Same dimension + same scale → equal regardless of spelling/SI prefix.
    expect(sameUnit("uIU/mL", "mIU/L")).toBe(true);
    expect(sameUnit("mcg/dL", "µg/dL")).toBe(true);
    expect(sameUnit("mcg/dL", "ug/dL")).toBe(true);
  });

  it("collapses heart-rate 'per minute' synonyms", () => {
    expect(sameUnit("bpm", "/min")).toBe(true);
    expect(sameUnit("beats/min", "bpm")).toBe(true);
  });

  it("reports genuinely different units as not matching", () => {
    expect(sameUnit("mg/dL", "mmol/L")).toBe(false);
    expect(sameUnit("mg/dL", "mg/L")).toBe(false);
  });

  it("collapses numerically identical count concentrations", () => {
    // 10^9/L == 10^3/uL (both 1e9 counts per liter); 10^12/L == 10^6/uL.
    expect(sameUnit("10^9/L", "10^3/uL")).toBe(true);
    expect(sameUnit("10^12/L", "10^6/uL")).toBe(true);
    // Different count scales are not equal.
    expect(sameUnit("10^3/uL", "10^6/uL")).toBe(false);
  });

  it("treats a bare lowercase enzyme unit as U (case-insensitive)", () => {
    expect(sameUnit("u/l", "U/L")).toBe(true);
    // Micro-prefixed real bases still parse as micro, distinct from enzyme U.
    expect(sameUnit("ug/mL", "U/L")).toBe(false);
    expect(sameUnit("umol/L", "mol/L")).toBe(false);
  });
});

describe("convertToCanonical", () => {
  const glucose = { name: "Glucose", unit: "mg/dL" };

  it("returns the value unchanged for identity / equivalent units", () => {
    expect(convertToCanonical(100, "mg/dL", glucose)).toBe(100);
    // Spelling variants that the unit parser treats as equivalent.
    expect(convertToCanonical(100, "mg / dL", glucose)).toBe(100);
  });

  it("returns the value when it cannot prove a unit (null reading unit)", () => {
    expect(convertToCanonical(100, null, glucose)).toBe(100);
  });

  it("rescales within the same dimension by the SI ratio", () => {
    // mg/dL → mg/L is ×10 (dL is 1/10 L).
    const cb = { name: "X", unit: "mg/L" };
    expect(convertToCanonical(10, "mg/dL", cb)).toBeCloseTo(100, 6);
  });

  it("returns null when value is null", () => {
    expect(convertToCanonical(null, "mg/dL", glucose)).toBeNull();
    expect(convertToCanonical(undefined, "mg/dL", glucose)).toBeNull();
  });

  it("returns null when genuinely unconvertible across dimensions with no factor", () => {
    // % has no concentration dimension and no curated factor to mg/dL.
    expect(convertToCanonical(5, "%", glucose)).toBeNull();
  });

  it("keeps identical count concentrations unchanged and rescales differing ones", () => {
    // Numerically identical → value unchanged.
    expect(convertToCanonical(5.5, "10^9/L", { unit: "10^3/uL" })).toBe(5.5);
    expect(convertToCanonical(4.8, "10^12/L", { unit: "10^6/uL" })).toBe(4.8);
    // Differing count scales rescale by their counts-per-liter ratio.
    expect(convertToCanonical(2, "10^6/uL", { unit: "10^3/uL" })).toBeCloseTo(
      2000,
      6
    );
  });

  it("converts a bare lowercase enzyme unit to the canonical U/L", () => {
    expect(convertToCanonical(30, "u/l", { name: "ALT", unit: "U/L" })).toBe(
      30
    );
  });
});

describe("isConvertible", () => {
  it("agrees with convertToCanonical", () => {
    const glucose = { name: "Glucose", unit: "mg/dL" };
    expect(isConvertible("mg/dL", glucose)).toBe(true);
    expect(isConvertible("%", glucose)).toBe(false);
  });
});

describe("bare count-per-volume canonical units (cells/uL)", () => {
  const anc = { name: "Neutrophils, Absolute", unit: "cells/uL" };

  it("converts scaled counts of ANY spelling to a bare cells/uL canonical", () => {
    // The generic count-ratio path handles caret AND UCUM-asterisk spellings —
    // 10^3/uL and 10*3/uL both = 1000× cells/uL — with no per-entry conversion.
    expect(convertToCanonical(0.6, "10^3/uL", anc)).toBeCloseTo(600);
    expect(convertToCanonical(0.6, "10*3/uL", anc)).toBeCloseTo(600);
    expect(convertToCanonical(0.6, "10*9/L", anc)).toBeCloseTo(600);
    expect(convertToCanonical(2.98, "K/uL", anc)).toBeCloseTo(2980);
    expect(convertToCanonical(2.98, "Thousand/uL", anc)).toBeCloseTo(2980);
    // A reading already in cells/uL (or spelling variants) is unchanged.
    expect(convertToCanonical(2134, "cells/uL", anc)).toBe(2134);
    expect(convertToCanonical(2134, "#/uL", anc)).toBe(2134);
  });

  it("declines a UNITLESS reading against a bare-count canonical (Finding 2)", () => {
    // A unitless ANC "7.5" is really 10^3/uL — assuming cells/uL would read it as
    // agranulocytosis. Decline (null) rather than guess.
    expect(convertToCanonical(7.5, null, anc)).toBeNull();
    expect(convertToCanonical(7.5, "", anc)).toBeNull();
    // But a SCALED-count canonical (10^3/uL, e.g. WBC) keeps the assume-canonical
    // convention: a unitless "11.0" is 11 ×10^3/uL.
    expect(convertToCanonical(11, null, { unit: "10^3/uL" })).toBe(11);
  });

  it("isBareCountPerVolume distinguishes bare counts from scaled/other units", () => {
    for (const u of ["cells/uL", "cells/µL", "#/uL", "/uL", "cell/L"])
      expect(isBareCountPerVolume(u)).toBe(true);
    for (const u of ["10^3/uL", "10*9/L", "%", "mg/dL", "/min", null])
      expect(isBareCountPerVolume(u)).toBe(false);
  });
});
