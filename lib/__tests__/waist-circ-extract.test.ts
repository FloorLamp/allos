import { describe, expect, it } from "vitest";
import type { ExtractedResult } from "../medical-extract";
import {
  waistCircToCm,
  isWaistCircReading,
  waistCircsFromReadings,
  waistCircsFromExtraction,
  WAIST_CIRC_METRIC,
  type WaistCircReading,
} from "../waist-circ-extract";
import { normalizeWaistInput, validateWaistInput } from "../waist-input";

// #2322 — the projector that earns the `waist-circ` slug its `import-projection`
// declaration. Both halves are tested here: the recognizer (what counts as a waist
// measurement) and the converter (what counts as a plausible one), because
// METRIC_DOCUMENT_REACH's honesty rests on the first and the chart's on the second.
//
// PHI: every name is a controlled-vocabulary analyte name or an invented spelling;
// the values are round invented numbers on invented dates.

function result(partial: Partial<ExtractedResult>): ExtractedResult {
  return {
    category: "vitals",
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

function reading(partial: Partial<WaistCircReading>): WaistCircReading {
  return {
    name: null,
    canonical: null,
    value_num: null,
    unit: null,
    date: null,
    ...partial,
  };
}

describe("isWaistCircReading", () => {
  it("matches by name / canonical, order- and punctuation-independently", () => {
    expect(isWaistCircReading("Waist Circumference", null)).toBe(true);
    expect(isWaistCircReading(null, "Waist Circumference")).toBe(true);
    expect(isWaistCircReading("waist circumference", null)).toBe(true);
    expect(isWaistCircReading("Circumference, Waist", null)).toBe(true);
    expect(isWaistCircReading("Waist Girth", null)).toBe(true);
    expect(
      isWaistCircReading(
        "Waist Circumference at Umbilicus by Tape Measure",
        null
      )
    ).toBe(true);
  });

  it("matches by LOINC even under a generic display name", () => {
    expect(isWaistCircReading("Measurement", null, "8280-0")).toBe(true);
    expect(isWaistCircReading("Measurement", null, "56086-2")).toBe(true);
  });

  it("REFUSES the waist/hip ratio — a ratio is not a length", () => {
    // Both axes, because a guard on one axis is not a guard (#2318's lesson): the
    // ratio LOINC is an explicit negative even when the row's display name would
    // otherwise match.
    expect(isWaistCircReading("Waist/Hip Ratio", null, "60803-4")).toBe(false);
    expect(isWaistCircReading("Waist Circumference", null, "60803-4")).toBe(
      false
    );
    expect(isWaistCircReading("Waist-Hip Ratio", null)).toBe(false);
  });

  it("refuses the neighbours a loose match would swallow", () => {
    // A bare "Waist" is a DEXA region label as often as a tape reading, and a fetal
    // abdominal circumference is not the subject's waist at all.
    expect(isWaistCircReading("Waist", null)).toBe(false);
    expect(isWaistCircReading("Abdominal Circumference", null)).toBe(false);
    expect(isWaistCircReading("Hip Circumference", null)).toBe(false);
    expect(isWaistCircReading("Head Circumference", null)).toBe(false);
    expect(isWaistCircReading(null, null)).toBe(false);
    expect(isWaistCircReading("", "")).toBe(false);
  });
});

describe("waistCircToCm", () => {
  it("passes cm through and converts inches / metres", () => {
    expect(waistCircToCm(84, "cm")).toBe(84);
    expect(waistCircToCm(34, "in")).toBe(86.4);
    expect(waistCircToCm(34, "[in_i]")).toBe(86.4);
    expect(waistCircToCm(0.84, "m")).toBe(84);
  });

  it("skips an unlabelled or unknown unit rather than guessing", () => {
    // A bare "34" is inches in a US portal and implausible as cm; the band cannot
    // tell them apart, so an ambiguous reading is dropped instead of guessed.
    expect(waistCircToCm(34, null)).toBeNull();
    expect(waistCircToCm(34, "")).toBeNull();
    expect(waistCircToCm(84, "%")).toBeNull();
  });

  it("drops values outside the 30–200 cm plausibility band", () => {
    expect(waistCircToCm(840, "cm")).toBeNull(); // a value in mm
    expect(waistCircToCm(20, "cm")).toBeNull();
    expect(waistCircToCm(30, "cm")).toBe(30);
    expect(waistCircToCm(200, "cm")).toBe(200);
  });
});

describe("waistCircsFromReadings", () => {
  it("folds to one sample per date, first plausible value winning", () => {
    const samples = waistCircsFromReadings(
      [
        reading({
          name: "Waist Circumference",
          value_num: 84,
          unit: "cm",
          date: "2026-03-02",
        }),
        reading({
          name: "Waist Circumference",
          value_num: 99,
          unit: "cm",
          date: "2026-03-02",
        }),
        reading({
          name: "Waist Girth",
          value_num: 32,
          unit: "in",
          date: "2026-03-01",
        }),
      ],
      null
    );
    expect(samples).toEqual([
      { date: "2026-03-01", waist_circumference_cm: 81.3 },
      { date: "2026-03-02", waist_circumference_cm: 84 },
    ]);
  });

  it("falls back to the document date, and skips a reading with no date at all", () => {
    expect(
      waistCircsFromReadings(
        [
          reading({
            name: "Waist Circumference",
            value_num: 84,
            unit: "cm",
            date: null,
          }),
        ],
        "2026-03-04"
      )
    ).toEqual([{ date: "2026-03-04", waist_circumference_cm: 84 }]);
    expect(
      waistCircsFromReadings(
        [
          reading({
            name: "Waist Circumference",
            value_num: 84,
            unit: "cm",
            date: "not-a-date",
          }),
        ],
        null
      )
    ).toEqual([]);
  });

  it("produces NOTHING for a value the converter refuses — the row stays a record", () => {
    expect(
      waistCircsFromReadings(
        [
          reading({
            name: "Waist Circumference",
            value_num: 84,
            unit: null,
            date: "2026-03-02",
          }),
          reading({
            name: "Waist/Hip Ratio",
            value_num: 0.9,
            unit: null,
            date: "2026-03-02",
          }),
        ],
        null
      )
    ).toEqual([]);
  });

  it("reads the AI extractor's shape through the same fold", () => {
    expect(
      waistCircsFromExtraction(
        [
          result({
            name: "Waist Circumference",
            canonical_name: "Waist Circumference",
            value_num: 84,
            unit: "cm",
            collected_date: "2026-03-02",
          }),
        ],
        null
      )
    ).toEqual([{ date: "2026-03-02", waist_circumference_cm: 84 }]);
  });

  it("names the metric_samples key once", () => {
    expect(WAIST_CIRC_METRIC).toBe("waist_circumference_cm");
  });
});

describe("normalizeWaistInput — the manual tape entry", () => {
  it("runs the SAME converter as the import path", () => {
    expect(
      normalizeWaistInput({ waistCirc: "84", waistCircUnit: "cm" })
    ).toEqual({ valueCm: 84 });
    expect(
      normalizeWaistInput({ waistCirc: "34", waistCircUnit: "in" })
    ).toEqual({ valueCm: 86.4 });
  });

  it("refuses a blank, an unparseable and an out-of-band value", () => {
    expect(validateWaistInput({ waistCirc: "", waistCircUnit: "cm" })).toBe(
      "Enter a valid waist measurement."
    );
    expect(validateWaistInput({ waistCirc: "wide", waistCircUnit: "cm" })).toBe(
      "Enter a valid waist measurement."
    );
    expect(validateWaistInput({ waistCirc: "840", waistCircUnit: "cm" })).toBe(
      "That waist measurement looks out of range."
    );
  });

  it("accepts a valid entry", () => {
    expect(
      validateWaistInput({ waistCirc: "84", waistCircUnit: "cm" })
    ).toBeNull();
  });
});
