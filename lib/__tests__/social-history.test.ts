import { describe, expect, it } from "vitest";
import {
  normalizeSocialSex,
  normalizeSmokingStatus,
  smokingConditionExternalId,
} from "../social-history";

describe("normalizeSocialSex", () => {
  it("maps the SNOMED sex findings", () => {
    expect(
      normalizeSocialSex({
        code: "248153007",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Male (finding)",
        nullFlavor: null,
      })
    ).toBe("male");
    expect(
      normalizeSocialSex({
        code: "248152002",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Female (finding)",
        nullFlavor: null,
      })
    ).toBe("female");
  });

  it("maps the HL7 AdministrativeGender / birth-sex M/F codes", () => {
    const v = (code: string) => ({
      code,
      codeSystem: "2.16.840.1.113883.5.1",
      displayName: null,
      nullFlavor: null,
    });
    expect(normalizeSocialSex(v("M"))).toBe("male");
    expect(normalizeSocialSex(v("F"))).toBe("female");
  });

  it("falls back to the display text when the code is unrecognized", () => {
    expect(
      normalizeSocialSex({
        code: "99999",
        codeSystem: null,
        displayName: "Female",
        nullFlavor: null,
      })
    ).toBe("female");
    expect(
      normalizeSocialSex({
        code: null,
        codeSystem: null,
        displayName: "Male",
        nullFlavor: null,
      })
    ).toBe("male");
  });

  it("returns null for a nullFlavor'd value (e.g. sex-at-birth UNK)", () => {
    expect(
      normalizeSocialSex({
        code: null,
        codeSystem: "2.16.840.1.113883.5.1",
        displayName: null,
        nullFlavor: "UNK",
      })
    ).toBeNull();
    expect(normalizeSocialSex(null)).toBeNull();
    expect(
      normalizeSocialSex({
        code: "X",
        codeSystem: null,
        displayName: "Other",
        nullFlavor: null,
      })
    ).toBeNull();
  });
});

describe("normalizeSmokingStatus", () => {
  it("keeps a tobacco-exposure risk-factor status with its coded display", () => {
    expect(
      normalizeSmokingStatus({
        code: "8517006",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Former smoker",
        nullFlavor: null,
      })
    ).toEqual({ code: "8517006", display: "Former smoker" });
    expect(
      normalizeSmokingStatus({
        code: "449868002",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Current every day smoker",
        nullFlavor: null,
      })
    ).toEqual({ code: "449868002", display: "Current every day smoker" });
  });

  it("drops the 'consumption unknown' sentinel (SNOMED 266927001)", () => {
    expect(
      normalizeSmokingStatus({
        code: "266927001",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Tobacco smoking consumption unknown",
        nullFlavor: null,
      })
    ).toBeNull();
  });

  it("drops 'Never smoker' — the absence of a risk factor is not a problem", () => {
    // SNOMED 266919005 by code, and by its text forms even under a different code.
    expect(
      normalizeSmokingStatus({
        code: "266919005",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Never smoker",
        nullFlavor: null,
      })
    ).toBeNull();
    expect(
      normalizeSmokingStatus({
        code: "99999",
        codeSystem: "2.16.840.1.113883.6.96",
        displayName: "Never smoked tobacco",
        nullFlavor: null,
      })
    ).toBeNull();
  });

  it("drops nullFlavor'd / never-assessed / not-asked values", () => {
    expect(
      normalizeSmokingStatus({
        code: null,
        codeSystem: null,
        displayName: "Former smoker",
        nullFlavor: "NA",
      })
    ).toBeNull();
    expect(
      normalizeSmokingStatus({
        code: "1",
        codeSystem: null,
        displayName: "Smoking status never assessed",
        nullFlavor: null,
      })
    ).toBeNull();
    expect(normalizeSmokingStatus(null)).toBeNull();
  });
});

describe("smokingConditionExternalId", () => {
  it("is stable and keyed on the SNOMED code", () => {
    const key = smokingConditionExternalId({
      code: "8517006",
      display: "Former smoker",
    });
    expect(key).toBe("ccda:social-smoking:8517006");
    // Same status → same key (idempotent across reprocess / merged documents).
    expect(
      smokingConditionExternalId({ code: "8517006", display: "Former smoker" })
    ).toBe(key);
  });

  it("falls back to the display when no code is present", () => {
    expect(
      smokingConditionExternalId({ code: null, display: "Former  smoker" })
    ).toBe("ccda:social-smoking:former smoker");
  });
});
