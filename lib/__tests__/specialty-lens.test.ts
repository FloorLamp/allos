// The specialty lens's pure classifier (issue #2921) — the four tiers of evidence
// and, more importantly, what each one REFUSES.
//
// The lens exists because a service line is a reading, not a stored fact, so the
// interesting assertions are the negatives: an unclassifiable visit belongs to no
// lens, and a condition is never name-matched into one.

import { describe, it, expect } from "vitest";
import {
  SPECIALTY_LINES,
  SPECIALTY_LINE_RULE_KEY,
  specialtyLineForCondition,
  specialtyLineForVisit,
  type SpecialtyLine,
  type SpecialtyVisitSignals,
} from "@/lib/specialty-lens";
import { PREVENTIVE_CONCEPT_MAP } from "@/lib/preventive-concept-map";
import { matchRuleKeys } from "@/lib/preventive-inference";

describe("specialtyLineForVisit (#2921)", () => {
  it.each([
    // ── The provider's own NUCC taxonomy code: the primary signal (#1056) ──
    [
      "provider NUCC ophthalmology",
      { providerSpecialtyCode: "207W00000X" },
      "vision",
    ],
    [
      "provider NUCC dentistry",
      { providerSpecialtyCode: "122300000X" },
      "dental",
    ],
    [
      "provider NUCC dermatology",
      { providerSpecialtyCode: "207N00000X" },
      "skin",
    ],
    [
      "provider NUCC audiologist",
      { providerSpecialtyCode: "231H00000X" },
      "hearing",
    ],
    // Case/whitespace are the import's, not the identity's.
    ["code is normalized", { providerSpecialtyCode: " 152w00000x " }, "vision"],

    // ── The specialty LABEL, when no code arrived ──
    ["provider label only", { providerSpecialty: "Optometry" }, "vision"],
    // The label tier carries dental on its own: whole-word matching never finds
    // the concept map's "dentist" inside "Dentistry".
    [
      "dentistry label",
      { providerSpecialty: "General Practice Dentistry" },
      "dental",
    ],
    ["orthodontics label", { providerSpecialty: "Orthodontics" }, "dental"],

    // ── The facility, as fallback (#1055) ──
    [
      "facility code when the clinician has none",
      { facilitySpecialtyCode: "207N00000X" },
      "skin",
    ],
    [
      "facility label when the clinician has none",
      { facilitySpecialty: "Audiology" },
      "hearing",
    ],
    [
      "the clinician outranks the facility",
      {
        providerSpecialtyCode: "207W00000X",
        facilitySpecialtyCode: "122300000X",
      },
      "vision",
    ],

    // ── The shared #515 free-text matcher ──
    // The anchor case: an org whose specialty lives only in its name.
    [
      "facility NAME keyword",
      {
        text: "Office Visit Excessive involuntary blinking Optum Pediatric Ophthalmology",
      },
      "vision",
    ],
    [
      "visit type code (CPT)",
      { code: "92014", text: "Office Visit" },
      "vision",
    ],
    ["dental keyword", { text: "Cleaning with the dentist" }, "dental"],
    ["audiology keyword", { text: "Audiology follow-up" }, "hearing"],
    ["dermatology keyword", { text: "Visit with Bay Dermatology" }, "skin"],

    // ── Refusals ──
    [
      "a generic office visit",
      { text: "Office Visit follow up Dr Reyes" },
      null,
    ],
    // adult_physical matches, and is not one of the four lines.
    ["an annual physical", { text: "Annual physical exam" }, null],
    // Deliberately excluded from the structured tier: an ENT practice is throat and
    // sinus care as often as ear care.
    [
      "an otolaryngology provider",
      {
        providerSpecialty: "Otolaryngology",
        providerSpecialtyCode: "207Y00000X",
      },
      null,
    ],
    ["a bare body word", { text: "skin lesion noted" }, null],
    ["nothing at all", {}, null],
  ] as [string, SpecialtyVisitSignals, SpecialtyLine | null][])(
    "%s → %s",
    (_name, visit, expected) => {
      expect(specialtyLineForVisit(visit)).toBe(expected);
    }
  );

  // The load-bearing claim of the whole module: the free-text vocabulary IS the
  // #515 concept map's, not a copy of it. Asserted as a property over the map —
  // every curated name of a line's rule classifies into that line — so a term
  // added there is covered here without anyone remembering to mirror it.
  it.each(SPECIALTY_LINES)(
    "reads %s's free-text vocabulary straight from the shared concept map",
    (line) => {
      const matcher = PREVENTIVE_CONCEPT_MAP.find(
        (m) => m.ruleKey === SPECIALTY_LINE_RULE_KEY[line]
      );
      expect(matcher).toBeDefined();
      expect(matcher!.names.length).toBeGreaterThan(0);
      for (const name of matcher!.names) {
        expect(specialtyLineForVisit({ text: name })).toBe(line);
        // ...and the same text still satisfies the preventive rule it always did.
        expect(matchRuleKeys({ name }, ["visit"])).toContain(matcher!.ruleKey);
      }
    }
  );
});

describe("specialtyLineForCondition (#2921)", () => {
  it.each([
    // The observed case this issue grew out of: strabismus, ICD-10 H50.
    [
      "strabismus",
      { name: "Strabismus", code: "H50.05", codeSystem: "ICD-10-CM" },
      "vision",
    ],
    [
      "conjunctivitis, dotless",
      { name: "Conjunctivitis", code: "H1033", codeSystem: "ICD-10-CM" },
      "vision",
    ],
    [
      "hearing loss",
      { name: "SNHL", code: "H90.3", codeSystem: "ICD-10-CM" },
      "hearing",
    ],
    [
      "dental caries",
      { name: "Caries", code: "K02.9", codeSystem: "ICD-10-CM" },
      "dental",
    ],
    [
      "atopic dermatitis",
      { name: "Eczema", code: "L20.9", codeSystem: "ICD-10-CM" },
      "skin",
    ],
    // Shape alone identifies ICD-10 when the importer stated no system.
    [
      "no stated system",
      { name: "Myopia", code: "H52.13", codeSystem: null },
      "vision",
    ],

    // ── Refusals ──
    // K09-K14 are jaw cysts, stomatitis and salivary glands — oral, not the
    // Dental pane's subject.
    [
      "stomatitis, past the dental block",
      { name: "Stomatitis", code: "K12.0", codeSystem: "ICD-10-CM" },
      null,
    ],
    [
      "a code in another chapter",
      { name: "Type 2 diabetes", code: "E11.9", codeSystem: "ICD-10-CM" },
      null,
    ],
    // A NAME is never enough: conditions have no curated synonym list behind them.
    [
      "an uncoded eye condition",
      { name: "Strabismus", code: null, codeSystem: null },
      null,
    ],
    [
      "a SNOMED-coded condition",
      { name: "Cataract", code: "193570009", codeSystem: "SNOMED CT" },
      null,
    ],
    [
      "a code from a vocabulary we do not read",
      { name: "Something", code: "H50.05", codeSystem: "ICD-9-CM" },
      null,
    ],
  ] as [
    string,
    { name: string; code: string | null; codeSystem: string | null },
    SpecialtyLine | null,
  ][])("%s → %s", (_name, condition, expected) => {
    expect(specialtyLineForCondition(condition)).toBe(expected);
  });
});
