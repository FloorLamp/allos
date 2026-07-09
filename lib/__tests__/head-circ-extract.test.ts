import { describe, expect, it } from "vitest";
import type { ExtractedResult } from "../medical-extract";
import {
  headCircToCm,
  isHeadCircReading,
  headCircsFromReadings,
  headCircsFromExtraction,
  type HeadCircReading,
} from "../head-circ-extract";

function result(partial: Partial<ExtractedResult>): ExtractedResult {
  return {
    category: "scan",
    panel: null,
    name: "",
    canonical_name: "",
    value: null,
    value_num: null,
    unit: null,
    reference_range: null,
    flag: null,
    collected_date: null,
    notes: null,
    ...partial,
  };
}

describe("isHeadCircReading", () => {
  it("matches head circumference by name / canonical (order-independent)", () => {
    expect(isHeadCircReading("Head Circumference", null)).toBe(true);
    expect(isHeadCircReading(null, "Occipital Frontal Circumference")).toBe(
      true
    );
    expect(
      isHeadCircReading("Head Occipital Frontal Circumference", null)
    ).toBe(true);
    expect(
      isHeadCircReading(
        "Head Occipital-frontal circumference by Tape measure",
        null
      )
    ).toBe(true);
    expect(isHeadCircReading("OFC", null)).toBe(true);
    expect(isHeadCircReading("circumference, head", null)).toBe(true); // comma inversion
  });

  it("matches head circumference by LOINC when the import carries one", () => {
    expect(isHeadCircReading("Observation", null, "8287-5")).toBe(true); // OFC by tape
    expect(isHeadCircReading(null, null, "9843-4")).toBe(true); // alias
  });

  it("does NOT treat the percentile LOINC 8289-1 as a measurement", () => {
    expect(isHeadCircReading("Head OFC Percentile", null, "8289-1")).toBe(
      false
    );
    // Even when a percentile row is MISLABELED with a measurement display name,
    // the explicit percentile-LOINC negative wins over the name match — it no
    // longer leans solely on the unit/plausibility guard downstream.
    expect(isHeadCircReading("Head Circumference", null, "8289-1")).toBe(false);
    expect(
      isHeadCircReading(null, "Occipital Frontal Circumference", "8289-1")
    ).toBe(false);
  });

  it("does NOT confuse head circ with height, weight, or another vital", () => {
    expect(isHeadCircReading("Body Height", "Body Height")).toBe(false);
    expect(isHeadCircReading("Body Weight", null)).toBe(false);
    expect(isHeadCircReading("Abdominal Circumference", null)).toBe(false);
    expect(isHeadCircReading("Waist Circumference", null)).toBe(false);
    expect(isHeadCircReading(null, null, "8302-2")).toBe(false); // height LOINC
    expect(isHeadCircReading("", "")).toBe(false); // empty must not match
    expect(isHeadCircReading(null, null, null)).toBe(false);
  });
});

describe("headCircToCm", () => {
  it("passes cm through", () => {
    expect(headCircToCm(46, "cm")).toBe(46);
    expect(headCircToCm(46.3, "centimeters")).toBe(46.3);
  });

  it("converts inches to cm (incl. UCUM [in_i])", () => {
    expect(headCircToCm(18, "in")).toBe(45.7);
    expect(headCircToCm(18, "[in_i]")).toBe(45.7);
  });

  it("converts meters to cm", () => {
    expect(headCircToCm(0.46, "m")).toBe(46);
  });

  it("rejects an ambiguous (missing/unknown) unit rather than guessing", () => {
    expect(headCircToCm(46, null)).toBeNull();
    expect(headCircToCm(46, "")).toBeNull();
    expect(headCircToCm(460, "mm")).toBeNull();
  });

  it("drops implausible values outside the 20–70 cm band", () => {
    expect(headCircToCm(460, "cm")).toBeNull(); // mis-unitted (mm as cm)
    expect(headCircToCm(10, "cm")).toBeNull(); // too small
    expect(headCircToCm(90, "cm")).toBeNull(); // too large
  });
});

describe("headCircsFromReadings", () => {
  const reading = (partial: Partial<HeadCircReading>): HeadCircReading => ({
    name: "Head Circumference",
    canonical: "Head Circumference",
    value_num: null,
    unit: "cm",
    date: "2026-06-01",
    ...partial,
  });

  it("projects a recognized head-circ reading into one dated cm sample", () => {
    expect(headCircsFromReadings([reading({ value_num: 44 })], null)).toEqual([
      { date: "2026-06-01", head_circumference_cm: 44 },
    ]);
  });

  it("recognizes a LOINC-only reading (generic name) and converts inches", () => {
    expect(
      headCircsFromReadings(
        [
          reading({
            name: "Observation",
            canonical: "Observation",
            loinc: "8287-5",
            value_num: 18,
            unit: "in",
          }),
        ],
        null
      )
    ).toEqual([{ date: "2026-06-01", head_circumference_cm: 45.7 }]);
  });

  it("never projects the percentile LOINC 8289-1", () => {
    expect(
      headCircsFromReadings(
        [
          reading({
            name: "Head OFC Percentile",
            canonical: "Head OFC Percentile",
            loinc: "8289-1",
            value_num: 55,
            unit: "%",
          }),
        ],
        null
      )
    ).toEqual([]);
  });

  it("falls back to the document date and skips readings with no resolvable date", () => {
    expect(
      headCircsFromReadings(
        [reading({ value_num: 47, date: null })],
        "2026-05-01"
      )
    ).toEqual([{ date: "2026-05-01", head_circumference_cm: 47 }]);
    expect(
      headCircsFromReadings([reading({ value_num: 47, date: null })], null)
    ).toEqual([]);
  });

  it("drops non-head-circ readings and rejected (implausible / unit-less) values", () => {
    expect(
      headCircsFromReadings(
        [
          reading({
            name: "Body Height",
            canonical: "Body Height",
            value_num: 68,
            unit: "cm",
          }),
          reading({ value_num: 46, unit: null }), // ambiguous unit → rejected
          reading({ value_num: 5000, unit: "cm" }), // implausible → rejected
        ],
        null
      )
    ).toEqual([]);
  });

  it("keeps the first plausible value per date", () => {
    expect(
      headCircsFromReadings(
        [
          reading({ value_num: 46, unit: "cm" }),
          reading({ value_num: 60, unit: "cm" }),
        ],
        null
      )
    ).toEqual([{ date: "2026-06-01", head_circumference_cm: 46 }]);
  });
});

describe("headCircsFromExtraction", () => {
  it("adapts AI results (dates from collected_date; name-based recognition)", () => {
    expect(
      headCircsFromExtraction(
        [
          result({
            name: "Head Circumference",
            canonical_name: "Head Circumference",
            value_num: 43,
            unit: "cm",
            collected_date: "2026-01-15",
          }),
        ],
        "2026-02-01"
      )
    ).toEqual([{ date: "2026-01-15", head_circumference_cm: 43 }]);
  });
});
