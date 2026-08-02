// PURE TIER — the family-history genetic axis (issue #1407).
//
// The predicate here decides whether a relative's history carries hereditary weight,
// so it is the one thing in this change that can produce a WRONG clinical read if it
// drifts: an adopted parent's coronary disease must not tighten a cardiac screen, and
// an ordinary unqualified relative must keep counting exactly as they always did.

import { describe, it, expect } from "vitest";
import {
  familyDeathLabel,
  familyRelationFacts,
  familyRelativeLabel,
  isGeneticRelative,
  toFamilyLineage,
  toFamilyRelationType,
} from "@/lib/family-relation";

describe("isGeneticRelative", () => {
  it("treats an UNSTATED relation type as genetic (hereditary by default)", () => {
    // Every row written before migration 145, and every import that says nothing.
    expect(isGeneticRelative(null)).toBe(true);
    expect(isGeneticRelative(undefined)).toBe(true);
  });

  it("counts a genetic relative and a half sibling", () => {
    expect(isGeneticRelative("genetic")).toBe(true);
    expect(isGeneticRelative("half")).toBe(true);
  });

  it("excludes an adopted or step relative", () => {
    expect(isGeneticRelative("adopted")).toBe(false);
    expect(isGeneticRelative("step")).toBe(false);
  });
});

describe("relation-type / lineage coercions", () => {
  it("accepts the enum terms case-insensitively", () => {
    expect(toFamilyRelationType("Adopted")).toBe("adopted");
    expect(toFamilyLineage(" MATERNAL ")).toBe("maternal");
  });

  it("drops anything off-vocabulary so a CHECK can never fail on insert", () => {
    expect(toFamilyRelationType("foster")).toBeNull();
    expect(toFamilyRelationType(3)).toBeNull();
    expect(toFamilyLineage("mother's side")).toBeNull();
  });
});

describe("familyRelationFacts", () => {
  it("reads the HL7 v3 role codes both importers hand it", () => {
    expect(familyRelationFacts("NMTH")).toEqual({
      relationType: "genetic",
      lineage: null,
    });
    expect(familyRelationFacts("HSIS")).toEqual({
      relationType: "half",
      lineage: null,
    });
    expect(familyRelationFacts("STPFTH")).toEqual({
      relationType: "step",
      lineage: null,
    });
    expect(familyRelationFacts("MGRMTH")).toEqual({
      relationType: null,
      lineage: "maternal",
    });
  });

  it("falls back to the display text when the code says nothing", () => {
    expect(familyRelationFacts("FTH", "Adoptive father").relationType).toBe(
      "adopted"
    );
    expect(familyRelationFacts(null, "Paternal grandfather").lineage).toBe(
      "paternal"
    );
    expect(familyRelationFacts(null, "Half-brother").relationType).toBe("half");
  });

  it("stays silent when the source states nothing", () => {
    expect(familyRelationFacts("FTH", "Father")).toEqual({
      relationType: null,
      lineage: null,
    });
    expect(familyRelationFacts(null, null)).toEqual({
      relationType: null,
      lineage: null,
    });
  });
});

describe("familyRelativeLabel", () => {
  it("names the discriminator — 'Father' and 'Father (adopted)' differ", () => {
    expect(familyRelativeLabel({ relation: "Father" })).toBe("Father");
    expect(
      familyRelativeLabel({ relation: "Father", relation_type: "adopted" })
    ).toBe("Father (adopted)");
    expect(
      familyRelativeLabel({ relation: "Sister", relation_type: "half" })
    ).toBe("Sister (half)");
  });

  it("adds the family side, and both qualifiers together", () => {
    expect(
      familyRelativeLabel({ relation: "Grandmother", lineage: "maternal" })
    ).toBe("Grandmother (maternal)");
    expect(
      familyRelativeLabel({
        relation: "Uncle",
        relation_type: "step",
        lineage: "paternal",
      })
    ).toBe("Uncle (step, paternal)");
  });

  it("does not repeat a qualifier the relation text already carries", () => {
    expect(
      familyRelativeLabel({
        relation: "Maternal grandmother",
        lineage: "maternal",
      })
    ).toBe("Maternal grandmother");
    expect(
      familyRelativeLabel({ relation: "Half-sister", relation_type: "half" })
    ).toBe("Half-sister");
  });

  it("adds nothing for the default genetic reading", () => {
    expect(
      familyRelativeLabel({ relation: "Mother", relation_type: "genetic" })
    ).toBe("Mother");
  });
});

describe("familyDeathLabel", () => {
  it("renders the age and the cause the cadence logic keys on", () => {
    expect(
      familyDeathLabel({
        deceased: 1,
        age_at_death: 52,
        cause_of_death: "Myocardial infarction",
      })
    ).toBe("Died at 52 — Myocardial infarction");
  });

  it("treats a stated age or cause as a stated death", () => {
    expect(familyDeathLabel({ deceased: null, age_at_death: 68 })).toBe(
      "Died at 68"
    );
    expect(familyDeathLabel({ deceased: null, cause_of_death: "Stroke" })).toBe(
      "Deceased — Stroke"
    );
  });

  it("renders nothing when no death is asserted", () => {
    expect(familyDeathLabel({ deceased: 0 })).toBeNull();
    expect(familyDeathLabel({})).toBeNull();
  });
});
