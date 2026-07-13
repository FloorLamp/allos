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
  isBirthEventOrEpisodic,
  isSelfLimitedCondition,
  decideImportedConditionStatus,
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

// ---- imported-condition status intelligence (#590) ----

describe("isBirthEventOrEpisodic", () => {
  it("detects ICD-10 Z38.* birth codes", () => {
    expect(isBirthEventOrEpisodic({ name: "Newborn", code: "Z38.0" })).toBe(
      true
    );
    expect(
      isBirthEventOrEpisodic({ name: "Liveborn infant", code: "Z38.00" })
    ).toBe(true);
    expect(isBirthEventOrEpisodic({ name: "Twin liveborn", code: "Z38" })).toBe(
      true
    );
  });
  it("detects liveborn SNOMED codes and narratives", () => {
    expect(
      isBirthEventOrEpisodic({
        name: "Single liveborn, born in hospital",
        code: null,
      })
    ).toBe(true);
    expect(
      isBirthEventOrEpisodic({ name: "Liveborn", code: "281050002" })
    ).toBe(true);
  });
  it("detects leaked 'encounter for…' Z-codes by name", () => {
    expect(
      isBirthEventOrEpisodic({
        name: "Encounter for immunization",
        code: "Z23",
      })
    ).toBe(true);
  });
  it("does not flag ordinary conditions", () => {
    expect(
      isBirthEventOrEpisodic({ name: "Essential hypertension", code: "I10" })
    ).toBe(false);
    expect(
      isBirthEventOrEpisodic({
        name: "Personal history of cancer",
        code: "Z85",
      })
    ).toBe(false);
  });
});

describe("isSelfLimitedCondition", () => {
  it("matches curated acute names", () => {
    for (const name of [
      "Fever",
      "Acute upper respiratory infection",
      "Viral syndrome",
      "Acute otitis media",
      "Influenza",
      "Acute cough",
      "Acute pharyngitis",
      "Acute bronchitis",
      "Acute sinusitis",
      "Common cold",
      "Viral gastroenteritis",
    ]) {
      expect(isSelfLimitedCondition({ name })).toBe(true);
    }
  });
  it("matches by acute ICD-10 code when the name is unusual", () => {
    expect(isSelfLimitedCondition({ name: "Pyrexia NOS", code: "R50.9" })).toBe(
      true
    );
  });
  it("never lists chronic-capable conditions (exclusion discipline)", () => {
    for (const name of [
      "Hypertension",
      "Asthma",
      "Type 2 diabetes mellitus",
      "COPD",
      "Chronic bronchitis",
      "Chronic sinusitis",
      "Allergic rhinitis",
      "Migraine",
    ]) {
      expect(isSelfLimitedCondition({ name })).toBe(false);
    }
  });
  it("chronic guard overrides an acute code sibling", () => {
    // J44 (COPD) is not in the acute code set; chronic bronchitis name is guarded.
    expect(
      isSelfLimitedCondition({ name: "Chronic bronchitis", code: "J44.9" })
    ).toBe(false);
  });
});

describe("decideImportedConditionStatus", () => {
  const now = new Date("2026-07-13T00:00:00Z");

  it("downgrades a birth event active row to resolved unconditionally", () => {
    const out = decideImportedConditionStatus({
      name: "Single liveborn, born in hospital",
      code: "Z38.0",
      status: "active",
      onsetDate: null,
      resolvedDate: null,
      explicitStatus: false,
      now,
    });
    expect(out.status).toBe("resolved");
    expect(out.resolved_date).toBeNull();
  });

  it("downgrades a stale self-limited problem-list active row", () => {
    const out = decideImportedConditionStatus({
      name: "Acute pharyngitis",
      code: "J02.9",
      status: "active",
      onsetDate: "2024-01-01", // > 90 days before `now`
      resolvedDate: null,
      explicitStatus: false,
      now,
    });
    expect(out.status).toBe("resolved");
    expect(out.onset_date).toBe("2024-01-01");
  });

  it("keeps a RECENT self-limited problem-list active row active (within horizon)", () => {
    const out = decideImportedConditionStatus({
      name: "Influenza",
      code: "J11.1",
      status: "active",
      onsetDate: "2026-07-01", // < 90 days before `now`
      resolvedDate: null,
      explicitStatus: false,
      now,
    });
    expect(out.status).toBe("active");
  });

  it("keeps an UNDATED self-limited problem-list row active (needs a date to age)", () => {
    const out = decideImportedConditionStatus({
      name: "Fever",
      code: "R50.9",
      status: "active",
      onsetDate: null,
      resolvedDate: null,
      explicitStatus: false,
      now,
    });
    expect(out.status).toBe("active");
  });

  it("downgrades a self-limited EPISODIC (visit-dx) row unconditionally, even undated", () => {
    const out = decideImportedConditionStatus({
      name: "Fever",
      code: "R50.9",
      status: "active",
      onsetDate: null,
      resolvedDate: null,
      explicitStatus: false,
      episodic: true,
      now,
    });
    expect(out.status).toBe("resolved");
  });

  it("keeps a chronic-capable episodic visit-dx active", () => {
    const out = decideImportedConditionStatus({
      name: "Essential hypertension",
      code: "I10",
      status: "active",
      onsetDate: "2020-01-01",
      resolvedDate: null,
      explicitStatus: false,
      episodic: true,
      now,
    });
    expect(out.status).toBe("active");
  });

  it("never touches an explicit clinical-status active on a listed name", () => {
    const out = decideImportedConditionStatus({
      name: "Influenza",
      code: "J11.1",
      status: "active",
      onsetDate: "2020-01-01",
      resolvedDate: null,
      explicitStatus: true,
      now,
    });
    expect(out.status).toBe("active");
  });

  it("never upgrades or rewrites a non-active status", () => {
    const out = decideImportedConditionStatus({
      name: "Fever",
      code: "R50.9",
      status: "resolved",
      onsetDate: "2020-01-01",
      resolvedDate: "2020-02-01",
      explicitStatus: false,
      episodic: true,
      now,
    });
    expect(out.status).toBe("resolved");
    expect(out.resolved_date).toBe("2020-02-01");
  });

  it("leaves an unlisted, non-birth active condition untouched", () => {
    const out = decideImportedConditionStatus({
      name: "Asthma",
      code: "J45.909",
      status: "active",
      onsetDate: "2015-01-01",
      resolvedDate: null,
      explicitStatus: false,
      now,
    });
    expect(out.status).toBe("active");
  });
});
