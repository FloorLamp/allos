import { describe, expect, it } from "vitest";
import {
  normalizeClinicalStatus,
  toAllergyStatus,
  toConditionStatus,
  isNoKnownAllergy,
  isNoKnownAllergyText,
  isNoKnownProblemText,
  allergyExternalId,
  conditionExternalId,
} from "../clinical-parse";

describe("normalizeClinicalStatus", () => {
  it("maps active variants", () => {
    expect(normalizeClinicalStatus("active")).toBe("active");
    expect(normalizeClinicalStatus("Active")).toBe("active");
    expect(normalizeClinicalStatus("55561003")).toBe("active");
    expect(normalizeClinicalStatus(null)).toBe("active");
    expect(normalizeClinicalStatus("")).toBe("active");
  });
  it("maps resolved variants (incl. concern-act 'completed')", () => {
    expect(normalizeClinicalStatus("resolved")).toBe("resolved");
    expect(normalizeClinicalStatus("Resolved")).toBe("resolved");
    expect(normalizeClinicalStatus("completed")).toBe("resolved");
    expect(normalizeClinicalStatus("413322009")).toBe("resolved");
  });
  it("maps inactive variants", () => {
    expect(normalizeClinicalStatus("inactive")).toBe("inactive");
    expect(normalizeClinicalStatus("73425007")).toBe("inactive");
    expect(normalizeClinicalStatus("suspended")).toBe("inactive");
    expect(normalizeClinicalStatus("aborted")).toBe("inactive");
  });
  it("aliases are typed narrowly", () => {
    expect(toAllergyStatus("resolved")).toBe("resolved");
    expect(toConditionStatus("active")).toBe("active");
  });
});

describe("no-known-allergy detection", () => {
  it("detects negated assertion with no substance", () => {
    expect(
      isNoKnownAllergy({ negated: true, substanceName: null, narrative: null })
    ).toBe(true);
    expect(
      isNoKnownAllergy({ negated: true, substanceName: "  ", narrative: null })
    ).toBe(true);
  });
  it("detects narrative phrasings", () => {
    expect(isNoKnownAllergyText("No known active allergies")).toBe(true);
    expect(isNoKnownAllergyText("NKDA")).toBe(true);
    expect(isNoKnownAllergyText("NKA")).toBe(true);
    expect(isNoKnownAllergyText("No known drug allergies")).toBe(true);
    expect(isNoKnownAllergyText("None")).toBe(false);
    expect(isNoKnownAllergyText("Penicillin")).toBe(false);
  });
  it("does not flag a real allergy as no-known", () => {
    expect(
      isNoKnownAllergy({
        negated: false,
        substanceName: "Penicillin",
        narrative: "Penicillin - hives",
      })
    ).toBe(false);
  });
  it("a narrative no-known wins even with a stray substance", () => {
    expect(
      isNoKnownAllergy({
        negated: false,
        substanceName: "x",
        narrative: "No known allergies",
      })
    ).toBe(true);
  });
});

describe("no-known-problem detection", () => {
  it("detects absence-of-problems phrasings", () => {
    expect(isNoKnownProblemText("No active problems")).toBe(true);
    expect(isNoKnownProblemText("No known problems")).toBe(true);
    expect(isNoKnownProblemText("Asthma")).toBe(false);
  });
});

describe("external-id builders", () => {
  it("prefers the code, falls back to name; includes onset", () => {
    expect(
      allergyExternalId({
        substance: "Penicillin",
        substanceCode: "7980",
        onsetDate: "2020-01-01",
      })
    ).toBe("ccda:allergy:7980:2020-01-01");
    expect(allergyExternalId({ substance: "Peanut", onsetDate: null })).toBe(
      "ccda:allergy:peanut:"
    );
    expect(
      conditionExternalId({
        name: "Asthma",
        code: "J45.909",
        onsetDate: "2019-06-01",
      })
    ).toBe("ccda:condition:j45.909:2019-06-01");
    expect(conditionExternalId({ name: "Asthma" })).toBe(
      "ccda:condition:asthma:"
    );
  });
});
