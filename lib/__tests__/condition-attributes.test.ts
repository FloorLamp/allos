// PURE TIER — condition laterality / severity / stage (issue #1403).
//
// Pins the two things the rest of the change leans on: the COERCIONS every write and
// import boundary runs (an off-vocabulary string must land as unstated, never as a
// failed insert or an invented claim), and the LABEL rule — a sided condition names
// its side, and never names it twice.

import { describe, it, expect } from "vitest";
import {
  conditionDisplayLabel,
  conditionGradeLabel,
  toConditionLaterality,
  toConditionSeverity,
  toConditionStage,
} from "@/lib/condition-attributes";

describe("toConditionLaterality", () => {
  it("reads the plain enum terms and their common abbreviations", () => {
    expect(toConditionLaterality("left")).toBe("left");
    expect(toConditionLaterality("Right")).toBe("right");
    expect(toConditionLaterality("BILATERAL")).toBe("bilateral");
    expect(toConditionLaterality("lt")).toBe("left");
    expect(toConditionLaterality("both")).toBe("bilateral");
  });

  it("reads a side out of a body-site phrase, on word boundaries", () => {
    expect(toConditionLaterality("Structure of left kidney")).toBe("left");
    expect(toConditionLaterality("Entire right knee region")).toBe("right");
    expect(toConditionLaterality("Bilateral lower extremities")).toBe(
      "bilateral"
    );
  });

  it("does not read a side out of a word that merely contains one", () => {
    // The reason the scan is boundary-anchored rather than a substring test.
    expect(toConditionLaterality("Cleft palate")).toBeNull();
    expect(toConditionLaterality("Bright red rash")).toBeNull();
  });

  it("maps the SNOMED laterality qualifier codes", () => {
    expect(toConditionLaterality("7771000")).toBe("left");
    expect(toConditionLaterality("24028007")).toBe("right");
    expect(toConditionLaterality("51440002")).toBe("bilateral");
  });

  it("leaves anything else unstated, including the imaging-only 'na'", () => {
    expect(toConditionLaterality("na")).toBeNull();
    expect(toConditionLaterality("midline")).toBeNull();
    expect(toConditionLaterality("")).toBeNull();
    expect(toConditionLaterality(null)).toBeNull();
    expect(toConditionLaterality(7771000)).toBeNull();
  });
});

describe("toConditionSeverity", () => {
  it("reads the enum terms, phrases containing them, and SNOMED grades", () => {
    expect(toConditionSeverity("moderate")).toBe("moderate");
    expect(toConditionSeverity("Severe persistent asthma")).toBe("severe");
    expect(toConditionSeverity("6736007")).toBe("moderate");
    expect(toConditionSeverity("24484000")).toBe("severe");
  });

  it("reads a straddling grade to the higher one it asserts", () => {
    expect(toConditionSeverity("moderate to severe")).toBe("severe");
    expect(toConditionSeverity("mild to moderate")).toBe("moderate");
  });

  it("leaves an ungraded value unstated", () => {
    expect(toConditionSeverity("grade 2")).toBeNull();
    expect(toConditionSeverity("")).toBeNull();
    expect(toConditionSeverity(undefined)).toBeNull();
  });
});

describe("toConditionStage", () => {
  it("keeps the printed stage verbatim, trimmed", () => {
    expect(toConditionStage("  Stage IIIA ")).toBe("Stage IIIA");
    expect(toConditionStage("3b")).toBe("3b");
    expect(toConditionStage("   ")).toBeNull();
  });
});

describe("conditionDisplayLabel", () => {
  it("names the side, because a sided condition is a distinct entity (#482)", () => {
    expect(
      conditionDisplayLabel({
        name: "Osteoarthritis of knee",
        laterality: "left",
      })
    ).toBe("Osteoarthritis of knee (left)");
    expect(
      conditionDisplayLabel({
        name: "Osteoarthritis of knee",
        laterality: "right",
      })
    ).toBe("Osteoarthritis of knee (right)");
  });

  it("does not repeat a side the name already states", () => {
    expect(
      conditionDisplayLabel({
        name: "Osteoarthritis, left knee",
        laterality: "left",
      })
    ).toBe("Osteoarthritis, left knee");
  });

  it("leaves an unsided condition alone", () => {
    expect(conditionDisplayLabel({ name: "Type 2 diabetes" })).toBe(
      "Type 2 diabetes"
    );
    expect(
      conditionDisplayLabel({ name: "Type 2 diabetes", laterality: null })
    ).toBe("Type 2 diabetes");
  });
});

describe("conditionGradeLabel", () => {
  it("renders severity and stage as one line, severity first", () => {
    expect(
      conditionGradeLabel({ name: "x", severity: "moderate", stage: "IIIA" })
    ).toBe("Moderate · Stage IIIA");
    expect(conditionGradeLabel({ name: "x", severity: "severe" })).toBe(
      "Severe"
    );
  });

  it("does not double the word 'stage' when the value already carries it", () => {
    expect(conditionGradeLabel({ name: "x", stage: "CKD stage 3b" })).toBe(
      "CKD stage 3b"
    );
    expect(conditionGradeLabel({ name: "x", stage: "Stage II" })).toBe(
      "Stage II"
    );
  });

  it("is null when the row states neither", () => {
    expect(conditionGradeLabel({ name: "x" })).toBeNull();
    expect(
      conditionGradeLabel({ name: "x", severity: null, stage: "  " })
    ).toBeNull();
  });
});
