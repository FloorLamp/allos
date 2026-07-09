import { describe, expect, it } from "vitest";
import type { ExtractedResult } from "../medical-extract";
import {
  heightToCm,
  isHeightReading,
  heightsFromReadings,
  heightsFromExtraction,
  type HeightReading,
} from "../height-extract";

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

describe("isHeightReading", () => {
  it("matches height by name / canonical (order-independent, punctuation-insensitive)", () => {
    expect(isHeightReading("Body Height", null)).toBe(true);
    expect(isHeightReading("Height", null)).toBe(true);
    expect(isHeightReading(null, "Stature")).toBe(true);
    expect(isHeightReading("Standing Height", null)).toBe(true);
    expect(isHeightReading("Body Length", null)).toBe(true);
    expect(isHeightReading("height, body", null)).toBe(true); // comma inversion
  });

  it("matches height by LOINC when the import carries one", () => {
    expect(isHeightReading("Observation", null, "8302-2")).toBe(true); // body height
    expect(isHeightReading(null, null, "3137-7")).toBe(true); // measured
    expect(isHeightReading(null, null, "8306-3")).toBe(true); // lying / length
    expect(isHeightReading(null, null, "8308-9")).toBe(true); // standing
  });

  it("does NOT confuse height with weight, a DEXA regional length, or another vital", () => {
    expect(isHeightReading("Body Weight", "Body Weight")).toBe(false);
    expect(isHeightReading("Total Body Mass", null)).toBe(false);
    expect(isHeightReading("Arm Length", null)).toBe(false); // regional segment
    expect(isHeightReading("Leg Length", null)).toBe(false);
    expect(isHeightReading("Systolic Blood Pressure", null)).toBe(false);
    expect(isHeightReading(null, null, "29463-7")).toBe(false); // weight LOINC
    expect(isHeightReading("", "")).toBe(false); // empty must not match
    expect(isHeightReading(null, null, null)).toBe(false);
  });
});

describe("heightToCm", () => {
  it("passes cm through", () => {
    expect(heightToCm(175, "cm")).toBe(175);
    expect(heightToCm(175.4, "centimeters")).toBe(175.4);
  });

  it("converts inches to cm (incl. UCUM [in_i])", () => {
    expect(heightToCm(70, "in")).toBe(177.8);
    expect(heightToCm(70, "[in_i]")).toBe(177.8);
    expect(heightToCm(24, "inches")).toBe(61); // infant length
  });

  it("converts meters to cm", () => {
    expect(heightToCm(1.75, "m")).toBe(175);
  });

  it("rejects an ambiguous (missing/unknown) unit rather than guessing", () => {
    expect(heightToCm(175, null)).toBeNull();
    expect(heightToCm(70, "")).toBeNull();
    expect(heightToCm(1750, "mm")).toBeNull();
  });

  it("drops implausible values outside the 30–260 cm band", () => {
    expect(heightToCm(1750, "cm")).toBeNull(); // mis-unitted (mm as cm)
    expect(heightToCm(20, "cm")).toBeNull(); // too small
    expect(heightToCm(300, "cm")).toBeNull(); // too large
  });
});

describe("heightsFromReadings", () => {
  const reading = (partial: Partial<HeightReading>): HeightReading => ({
    name: "Body Height",
    canonical: "Body Height",
    value_num: null,
    unit: "cm",
    date: "2026-06-01",
    ...partial,
  });

  it("projects a recognized height reading into one dated cm sample", () => {
    expect(heightsFromReadings([reading({ value_num: 178 })], null)).toEqual([
      { date: "2026-06-01", height_cm: 178 },
    ]);
  });

  it("recognizes a LOINC-only reading (generic name) and converts inches", () => {
    expect(
      heightsFromReadings(
        [
          reading({
            name: "Observation",
            canonical: "Observation",
            loinc: "8302-2",
            value_num: 68,
            unit: "in",
          }),
        ],
        null
      )
    ).toEqual([{ date: "2026-06-01", height_cm: 172.7 }]);
  });

  it("falls back to the document date and skips readings with no resolvable date", () => {
    expect(
      heightsFromReadings(
        [reading({ value_num: 180, date: null })],
        "2026-05-01"
      )
    ).toEqual([{ date: "2026-05-01", height_cm: 180 }]);
    expect(
      heightsFromReadings([reading({ value_num: 180, date: null })], null)
    ).toEqual([]);
  });

  it("drops non-height readings and rejected (implausible / unit-less) heights", () => {
    expect(
      heightsFromReadings(
        [
          reading({
            name: "Body Weight",
            canonical: "Body Weight",
            value_num: 82,
            unit: "kg",
          }),
          reading({ value_num: 175, unit: null }), // ambiguous unit → rejected
          reading({ value_num: 5000, unit: "cm" }), // implausible → rejected
        ],
        null
      )
    ).toEqual([]);
  });

  it("keeps the first plausible value per date", () => {
    expect(
      heightsFromReadings(
        [
          reading({ value_num: 178, unit: "cm" }),
          reading({ value_num: 200, unit: "cm" }),
        ],
        null
      )
    ).toEqual([{ date: "2026-06-01", height_cm: 178 }]);
  });
});

describe("heightsFromExtraction", () => {
  it("adapts AI results (dates from collected_date; name-based recognition)", () => {
    expect(
      heightsFromExtraction(
        [
          result({
            name: "Height",
            canonical_name: "Body Height",
            value_num: 165,
            unit: "cm",
            collected_date: "2026-01-15",
          }),
        ],
        "2026-02-01"
      )
    ).toEqual([{ date: "2026-01-15", height_cm: 165 }]);
  });
});
