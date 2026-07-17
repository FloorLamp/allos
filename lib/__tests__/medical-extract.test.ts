import { describe, it, expect } from "vitest";
import {
  normalizeSex,
  normalizeBirthdate,
  normalizeAge,
  normalizeClinicalDomains,
  normalizePrescription,
  normalizeResults,
  unwrapExtractionInput,
  looksLikeExtractionInput,
} from "@/lib/medical-extract";

// A minimal, SYNTHETIC payload in the tool schema's flat shape.
const FLAT_PAYLOAD = {
  document_type: "lab report",
  document_date: "2024-01-01",
  results: [
    {
      category: "lab",
      name: "Sodium",
      canonical_name: "Sodium",
      value: "140",
      value_num: 140,
      unit: "mmol/L",
    },
  ],
};

describe("extraction shape recognition + unwrap", () => {
  it("recognizes a flat payload, including a genuinely EMPTY document", () => {
    expect(looksLikeExtractionInput(FLAT_PAYLOAD)).toBe(true);
    // A document with nothing to extract still answers with the schema's keys and
    // empty arrays — that is legitimately empty, NOT misshapen.
    expect(
      looksLikeExtractionInput({ document_type: "letter", results: [] })
    ).toBe(true);
  });

  it("does not recognize a wrapper, a non-object, or an unrelated object", () => {
    expect(looksLikeExtractionInput({ document_data: FLAT_PAYLOAD })).toBe(
      false
    );
    expect(looksLikeExtractionInput({ nope: 1 })).toBe(false);
    expect(looksLikeExtractionInput([FLAT_PAYLOAD])).toBe(false);
    expect(looksLikeExtractionInput(null)).toBe(false);
  });

  it("lifts a payload the model nested under one envelope key", () => {
    // The observed failure: the whole payload wrapped in {document_data: {...}},
    // which every normalizer read straight past → zero records, no error.
    expect(unwrapExtractionInput({ document_data: FLAT_PAYLOAD })).toEqual(
      FLAT_PAYLOAD
    );
    // The envelope name doesn't matter — recognition is by the schema's keys.
    expect(unwrapExtractionInput({ extraction: FLAT_PAYLOAD })).toEqual(
      FLAT_PAYLOAD
    );
  });

  it("returns an already-correct payload untouched", () => {
    expect(unwrapExtractionInput(FLAT_PAYLOAD)).toBe(FLAT_PAYLOAD);
  });

  it("leaves an ambiguous or unrecognizable object alone (no guessing)", () => {
    // Two equally payload-shaped values: which one is the document? Don't guess —
    // the caller's shape guard rejects it instead.
    const ambiguous = { a: FLAT_PAYLOAD, b: FLAT_PAYLOAD };
    expect(unwrapExtractionInput(ambiguous)).toBe(ambiguous);
    const junk = { foo: 1 };
    expect(unwrapExtractionInput(junk)).toBe(junk);
    expect(unwrapExtractionInput({})).toEqual({});
  });

  // The nastiest variant: an envelope PLUS a stray top-level schema key. A
  // "names any key?" test judges this already-flat, skips the unwrap, and
  // reproduces the exact zero-record bug. The payload must win on score.
  it("lifts the payload out of a HYBRID envelope (wrapper + a stray top-level key)", () => {
    const hybrid = { document_type: "lab report", document_data: FLAT_PAYLOAD };
    expect(unwrapExtractionInput(hybrid)).toEqual(FLAT_PAYLOAD);
    // …and the records actually come through, which is the point.
    expect(normalizeResults(unwrapExtractionInput(hybrid))).toHaveLength(1);
  });

  it("picks the payload over a weaker sibling metadata object", () => {
    // {payload, metadata:{source}} — `source` alone is a schema key, so a
    // presence test would call this ambiguous and reject a recoverable response.
    const withSibling = {
      document_data: FLAT_PAYLOAD,
      metadata: { source: "Some Lab" },
    };
    expect(unwrapExtractionInput(withSibling)).toEqual(FLAT_PAYLOAD);
  });

  it("does not dig into a payload's own values (input wins ties)", () => {
    // A correct payload is returned as-is even though it contains objects.
    const nestedish = {
      ...FLAT_PAYLOAD,
      source: "Lab",
      extra: { results: [] },
    };
    expect(unwrapExtractionInput(nestedish)).toBe(nestedish);
  });

  it("regression: a wrapped payload normalizes to 0 records raw, all records unwrapped", () => {
    const wrapped = { document_data: FLAT_PAYLOAD };
    // The bug: reading the wrapper directly silently yields nothing.
    expect(normalizeResults(wrapped)).toHaveLength(0);
    // Unwrapped, the records come through.
    const recovered = normalizeResults(unwrapExtractionInput(wrapped));
    expect(recovered).toHaveLength(1);
    expect(recovered[0].name).toBe("Sodium");
    expect(recovered[0].value_num).toBe(140);
  });
});

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

describe("normalizePrescription (#414)", () => {
  it("returns null for a missing / non-object / empty prescription", () => {
    expect(normalizePrescription(undefined)).toBeNull();
    expect(normalizePrescription(null)).toBeNull();
    expect(normalizePrescription("nope")).toBeNull();
    // An all-null object carries nothing usable — null so it never masks the
    // parsePrescription fallback.
    expect(
      normalizePrescription({
        sig: null,
        strength: null,
        prn: null,
        prescriber: null,
        pharmacy: null,
        rx_number: null,
        start_date: null,
      })
    ).toBeNull();
  });

  it("coerces the structured fields the model reads off a label", () => {
    const p = normalizePrescription({
      sig: "Take 1 tablet by mouth daily",
      strength: "10 mg",
      prn: 0,
      prescriber: "Grace Hopper, MD",
      pharmacy: "Test Pharmacy #12",
      rx_number: "RX-555031",
      start_date: "2024-02-01",
    });
    expect(p).toEqual({
      sig: "Take 1 tablet by mouth daily",
      strength: "10 mg",
      prn: 0,
      prescriber: "Grace Hopper, MD",
      pharmacy: "Test Pharmacy #12",
      rx_number: "RX-555031",
      start_date: "2024-02-01",
    });
  });

  it("collapses a boolean/yes-no prn to 1/0 and drops a junk start_date", () => {
    expect(normalizePrescription({ prn: true })?.prn).toBe(1);
    expect(normalizePrescription({ prn: "yes" })?.prn).toBe(1);
    expect(normalizePrescription({ prn: false, sig: "x" })?.prn).toBe(0);
    // A junk start_date drops to null (kept alongside a usable sig so the object
    // isn't itself null).
    expect(
      normalizePrescription({ sig: "x", start_date: "02/01/2024" })?.start_date
    ).toBe(null);
  });
});
