import { describe, expect, it } from "vitest";
import {
  crossCheckDrugAllergies,
  drugAllergySignalKey,
  drugAllergyTitle,
  drugAllergyDetail,
  drugAllergyEvidence,
  isRxNormCodeSystem,
  DRUG_ALLERGY_PREFIX,
  type AllergyRecordInput,
  type DrugAllergyMedInput,
} from "@/lib/drug-allergy";

// Pure-tier pins for the drug-allergy × medication-stack cross-check (issue #1029),
// over hand-built synthetic fixtures. The DB gather tier
// (lib/__db_tests__/drug-allergy-crosscheck.test.ts) covers the end-to-end
// penicillin/amoxicillin fixture per #448; here the matcher itself is pinned:
// code hit, name hit, class hit, cross-class hit (with the low-rate wording),
// no-hit for an unrelated med, and the id-keyed dedupeKey shape.

function allergy(over: Partial<AllergyRecordInput> = {}): AllergyRecordInput {
  return {
    id: 11,
    substance: "Penicillin",
    substanceCode: null,
    substanceCodeSystem: null,
    reaction: "hives",
    ...over,
  };
}

function med(over: Partial<DrugAllergyMedInput> = {}): DrugAllergyMedInput {
  return {
    id: 21,
    name: "Amoxicillin 500 mg",
    rxcui: null,
    rxcuiIngredients: null,
    ...over,
  };
}

describe("crossCheckDrugAllergies (#1029)", () => {
  it("code hit: the allergen's RxNorm CUI equals a med ingredient CUI (authoritative)", () => {
    // Synthetic CUI — the code path compares strings, so a fake code exercises it.
    const hits = crossCheckDrugAllergies(
      [
        allergy({
          substance: "Some Coded Allergen",
          substanceCode: "999001",
          substanceCodeSystem: "RxNorm",
        }),
      ],
      [
        med({
          name: "Branded Combo Product",
          rxcui: "999900",
          rxcuiIngredients: ["999001", "999002"],
        }),
      ]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("ingredient");
    expect(hits[0].dedupeKey).toBe("allergy-med:11-21");
  });

  it("never compares a non-RxNorm allergen code against med CUIs", () => {
    const hits = crossCheckDrugAllergies(
      [
        allergy({
          substance: "Unrelated Substance",
          substanceCode: "999001",
          substanceCodeSystem: "http://snomed.info/sct",
        }),
      ],
      [med({ name: "Unrelated Med", rxcuiIngredients: ["999001"] })]
    );
    expect(hits).toHaveLength(0);
  });

  it("recognizes RxNorm code systems by name, URI, and OID", () => {
    expect(isRxNormCodeSystem("RxNorm")).toBe(true);
    expect(
      isRxNormCodeSystem("http://www.nlm.nih.gov/research/umls/rxnorm")
    ).toBe(true);
    expect(isRxNormCodeSystem("2.16.840.1.113883.6.88")).toBe(true);
    expect(isRxNormCodeSystem("http://snomed.info/sct")).toBe(false);
    expect(isRxNormCodeSystem(null)).toBe(false);
  });

  it("name hit: 'penicillin' allergy × 'Penicillin V Potassium 500 mg' med (token containment)", () => {
    const hits = crossCheckDrugAllergies(
      [allergy({ substance: "penicillin", reaction: null })],
      [med({ name: "Penicillin V Potassium 500 mg" })]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("ingredient");
  });

  it("name hit works in the reverse direction ('Amoxicillin trihydrate' allergen × 'Amoxicillin' med)", () => {
    const hits = crossCheckDrugAllergies(
      [allergy({ substance: "Amoxicillin trihydrate" })],
      [med({ name: "Amoxicillin" })]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("ingredient");
  });

  it("class hit: a penicillin allergy matches an amoxicillin med through the curated class", () => {
    const hits = crossCheckDrugAllergies(
      [allergy()],
      [med({ name: "Amoxicillin 500 mg" })]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("class");
    expect(hits[0].note).toContain("penicillin-class");
    expect(hits[0].source.trim().length).toBeGreaterThan(0);
  });

  it("cross-class hit: penicillin allergy × cephalexin carries the possible-cross-reactivity wording", () => {
    const hits = crossCheckDrugAllergies(
      [allergy()],
      [med({ name: "Cephalexin 250 mg" })]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("cross-class");
    expect(hits[0].note.toLowerCase()).toContain("cross-reactivity");
    // The modern low-rate framing, not an alarm.
    expect(hits[0].note.toLowerCase()).toContain("low");
  });

  it("cross-class works in the other direction (aspirin allergy × ibuprofen med, and vice versa)", () => {
    const a = crossCheckDrugAllergies(
      [allergy({ substance: "Aspirin" })],
      [med({ name: "Ibuprofen 200 mg" })]
    );
    expect(a).toHaveLength(1);
    expect(a[0].match).toBe("cross-class");
    const b = crossCheckDrugAllergies(
      [allergy({ substance: "Ibuprofen" })],
      [med({ name: "Aspirin 81 mg" })]
    );
    expect(b).toHaveLength(1);
    expect(b[0].match).toBe("cross-class");
  });

  it("no hit for an unrelated med, an empty substance, or empty inputs", () => {
    expect(
      crossCheckDrugAllergies([allergy()], [med({ name: "Metformin 500 mg" })])
    ).toHaveLength(0);
    expect(
      crossCheckDrugAllergies([allergy({ substance: "  " })], [med()])
    ).toHaveLength(0);
    expect(crossCheckDrugAllergies([], [med()])).toHaveLength(0);
    expect(crossCheckDrugAllergies([allergy()], [])).toHaveLength(0);
  });

  it("one hit per (allergy, med) pair — the most specific tier wins", () => {
    // "Penicillin" med name direct-matches the "Penicillin" allergen AND both sit in
    // the penicillins class; only the ingredient hit must surface.
    const hits = crossCheckDrugAllergies(
      [allergy()],
      [med({ name: "Penicillin VK" })]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("ingredient");
  });

  it("dedupeKey is id-keyed under the registered namespace and formatting stays informational", () => {
    const hits = crossCheckDrugAllergies([allergy()], [med()]);
    const hit = hits[0];
    expect(hit.dedupeKey.startsWith(DRUG_ALLERGY_PREFIX)).toBe(true);
    expect(hit.dedupeKey).toBe(drugAllergySignalKey(11, 21));
    expect(drugAllergyTitle(hit)).toContain("Amoxicillin 500 mg");
    expect(drugAllergyTitle(hit)).toContain("Penicillin");
    // The recorded reaction reads as recorded; the guardrail is never prescriptive.
    expect(drugAllergyDetail(hit)).toContain("recorded reaction: hives");
    expect(drugAllergyEvidence(hit)).toContain("with your prescriber");
    expect(drugAllergyEvidence(hit)).toContain("not clearance");
    expect(drugAllergyEvidence(hit)).not.toContain("stop taking");
  });
});
