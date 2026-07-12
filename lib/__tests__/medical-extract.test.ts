import { describe, it, expect } from "vitest";
import {
  normalizeSex,
  normalizeBirthdate,
  normalizeAge,
  normalizeClinicalDomains,
} from "@/lib/medical-extract";

describe("normalizeSex", () => {
  it("maps male spellings to 'male'", () => {
    expect(normalizeSex("M")).toBe("male");
    expect(normalizeSex("male")).toBe("male");
    expect(normalizeSex("Male")).toBe("male");
    expect(normalizeSex("MALE")).toBe("male");
    expect(normalizeSex("man")).toBe("male");
    expect(normalizeSex("  m ")).toBe("male");
  });

  it("maps female spellings to 'female'", () => {
    expect(normalizeSex("F")).toBe("female");
    expect(normalizeSex("female")).toBe("female");
    expect(normalizeSex("Female")).toBe("female");
    expect(normalizeSex("FEMALE")).toBe("female");
    expect(normalizeSex("woman")).toBe("female");
  });

  it("returns null for absent or unrecognized values", () => {
    expect(normalizeSex(null)).toBeNull();
    expect(normalizeSex(undefined)).toBeNull();
    expect(normalizeSex("")).toBeNull();
    expect(normalizeSex("unknown")).toBeNull();
    expect(normalizeSex("other")).toBeNull();
    expect(normalizeSex("X")).toBeNull();
    expect(normalizeSex(1)).toBeNull();
  });
});

describe("normalizeBirthdate", () => {
  it("accepts a strict ISO YYYY-MM-DD date", () => {
    expect(normalizeBirthdate("1985-04-20")).toBe("1985-04-20");
    expect(normalizeBirthdate("  1985-04-20 ")).toBe("1985-04-20");
  });

  it("rejects non-ISO or partial dates", () => {
    expect(normalizeBirthdate("1985")).toBeNull();
    expect(normalizeBirthdate("04/20/1985")).toBeNull();
    expect(normalizeBirthdate("Apr 20 1985")).toBeNull();
    expect(normalizeBirthdate("")).toBeNull();
    expect(normalizeBirthdate(null)).toBeNull();
    expect(normalizeBirthdate(19850420)).toBeNull();
  });
});

describe("normalizeAge", () => {
  it("accepts plausible ages from numbers and numeric strings", () => {
    expect(normalizeAge(45)).toBe(45);
    expect(normalizeAge("45")).toBe(45);
    expect(normalizeAge("45 years")).toBe(45);
    expect(normalizeAge(45.6)).toBe(46);
  });

  it("rejects absent or implausible ages", () => {
    expect(normalizeAge(0)).toBeNull();
    expect(normalizeAge(-3)).toBeNull();
    expect(normalizeAge(200)).toBeNull();
    expect(normalizeAge("")).toBeNull();
    expect(normalizeAge("old")).toBeNull();
    expect(normalizeAge(null)).toBeNull();
  });
});

describe("normalizeClinicalDomains", () => {
  it("returns empty arrays + no drops for absent/garbage input", () => {
    const out = normalizeClinicalDomains({});
    expect(out.conditions).toEqual([]);
    expect(out.allergies).toEqual([]);
    expect(out.procedures).toEqual([]);
    expect(out.encounters).toEqual([]);
    expect(out.familyHistory).toEqual([]);
    expect(out.carePlanItems).toEqual([]);
    expect(out.careGoals).toEqual([]);
    expect(out.drops).toEqual([]);
    // A non-array field is tolerated (treated as empty), not thrown on.
    expect(normalizeClinicalDomains({ conditions: "nope" }).conditions).toEqual(
      []
    );
  });

  it("coerces shapes and keeps the model's raw status (normalized downstream)", () => {
    const out = normalizeClinicalDomains({
      conditions: [
        {
          name: "  Asthma  ",
          code: "J45.909",
          code_system: "ICD-10-CM",
          status: "Active",
          onset_date: "2015-01-01",
          resolved_date: "not-a-date",
        },
      ],
    });
    expect(out.conditions).toEqual([
      {
        name: "Asthma",
        code: "J45.909",
        code_system: "ICD-10-CM",
        status: "Active", // raw — enum normalization happens in import-shape
        onset_date: "2015-01-01",
        resolved_date: null, // junk date dropped to null
      },
    ]);
  });

  it("drops entries missing their required identifier, with a reported reason", () => {
    const out = normalizeClinicalDomains({
      conditions: [{ name: "  " }, { name: "Diabetes" }],
      allergies: [{ reaction: "Hives" }], // no substance
      procedures: [{ code: "44970" }], // no name
      encounters: [{ type: "Office Visit" }], // no date
      family_history: [{ relation: "mother" }], // no condition
      care_plan: [{ status: "planned" }], // no description
      care_goals: [{ code: "x" }], // no description
    });
    expect(out.conditions.map((c) => c.name)).toEqual(["Diabetes"]);
    expect(out.drops.map((d) => d.kind).sort()).toEqual([
      "allergy",
      "care_goal",
      "care_plan",
      "condition",
      "encounter",
      "family_history",
      "procedure",
    ]);
    expect(out.drops.every((d) => d.reason === "no_value")).toBe(true);
    // The undated encounter's drop keeps its type as the label.
    expect(out.drops.find((d) => d.kind === "encounter")?.label).toBe(
      "Office Visit"
    );
  });

  it("coerces encounter diagnoses + deceased flag", () => {
    const out = normalizeClinicalDomains({
      encounters: [
        {
          date: "2024-02-01",
          diagnoses: ["Fever", "", null, "Cough"],
          provider: "Grace Hopper",
          location: "Sample Clinic",
        },
      ],
      family_history: [
        { condition: "Stroke", deceased: "yes", onset_age: "70" },
      ],
    });
    expect(out.encounters[0].diagnoses).toEqual(["Fever", "Cough"]);
    expect(out.encounters[0].provider).toBe("Grace Hopper");
    expect(out.familyHistory[0].deceased).toBe(1);
    expect(out.familyHistory[0].onset_age).toBe(70);
  });
});
