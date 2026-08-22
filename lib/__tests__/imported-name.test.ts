import { describe, expect, it } from "vitest";
import {
  isCleanerName,
  isImportedDocumentName,
  shoutingWords,
} from "@/lib/imported-name";

// The imported-name predicate's own proof (#3480), in the
// lib/__tests__/nul-byte-census.test.ts tradition: a green run over names that
// comply says nothing about what the rule can SEE, so the rule is run over names
// authored to break it AND over the benign neighbours it must stay quiet on.
//
// The quiet half carries most of the weight here. This predicate licenses an OFFER
// to rename a medication, and a rule that fired on ordinary names would train people
// to dismiss the offer — at which point the real one, on a genuine portal string,
// goes unread too.

describe("isImportedDocumentName — the shapes portals actually export", () => {
  // The observed defect, verbatim from the owner's 2026-08-21 phone review.
  const OBSERVED = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";

  const DOCUMENT_STRINGS = [
    OBSERVED,
    // The same shape without the leading generic name.
    "CALCIUM 500 + D OR",
    // The other common portal rendering: the whole line shouted.
    "LISINOPRIL 10MG TAB",
    "METFORMIN HCL ER 500 MG TABLET",
    // One shouted word carrying most of the letters — the drug's own name shouted.
    "PREDNISONE 10 mg",
    "HCTZ 25 mg",
    // A dose-form code beside a shouted brand.
    "EPIPEN 2-PAK",
  ];

  for (const name of DOCUMENT_STRINGS) {
    it(`sees ${JSON.stringify(name)}`, () => {
      expect(
        isImportedDocumentName(name),
        `the rule must SEE ${JSON.stringify(name)} — a rule blind to the ` +
          `shape it was written for turns "nobody has hit this" into "nobody ` +
          `can", and only the first is true`
      ).toBe(true);
    });
  }

  it("reads the observed string off the words that actually shout", () => {
    // Not just the verdict: a rule that reached `true` off "Cholecalciferol" or
    // off the digits would agree with this suite and disagree with reality.
    expect(shoutingWords(OBSERVED)).toEqual(["CALCIUM", "OR"]);
  });
});

describe("isImportedDocumentName — the names a person writes", () => {
  const BENIGN = [
    // The doctrine's own example: the string a title-case pass would mangle
    // (lib/allergen-vocabulary.ts:35).
    "penicillin v potassium",
    // Plain names, in every casing somebody actually types.
    "Aspirin",
    "aspirin",
    "Lisinopril 10 mg",
    "Tylenol (acetaminophen)",
    "amoxicillin (400 mg/5 mL) suspension",
    // ONE acronym is ordinary in a name and must not be enough on its own.
    "Vitamin D3 5000 IU",
    "Metformin HCl ER",
    "Magnesium glycinate 400 mg",
    // Mixed-case product spellings that a naive all-caps scan would trip on.
    "CoQ10",
    "EpiPen",
    "NSAIDs",
    "Vitamin B12",
    // Empty / whitespace: nothing to offer.
    "",
    "   ",
  ];

  for (const name of BENIGN) {
    it(`stays quiet on ${JSON.stringify(name)}`, () => {
      expect(
        isImportedDocumentName(name),
        `the rule must stay QUIET on ${JSON.stringify(name)} — an offer that ` +
          `fires on ordinary names is dismissed by habit, and the real one goes ` +
          `with it`
      ).toBe(false);
    });
  }
});

describe("the fixtures that already sit near this boundary", () => {
  // Every medication a fixture or seed inserts as `source = 'extracted'` — the
  // complete set, and the only rows the offer can ever reach: e2e/seed/imports.ts,
  // e2e/timeline-linked-context.spec.ts, scripts/seed.ts. All three must land on the
  // QUIET side, or an offer card appears above the import page's medication listing
  // in specs that never asked for one.
  const SEEDED_EXTRACTED = ["E2E Loratadine", "E2E Lisinopril", "Atorvastatin"];

  for (const name of SEEDED_EXTRACTED) {
    it(`leaves the seeded ${JSON.stringify(name)} alone`, () => {
      expect(isImportedDocumentName(name)).toBe(false);
    });
  }

  it("does not light up on the e2e naming convention", () => {
    // THE CLOSE CALL, and it is worth pinning on its own. Every e2e fixture is
    // prefixed "E2E ", which IS a shouted word — "E2E Loratadine" is quiet only
    // because 3 of its 13 letters shout, under the 0.5 share. Lower that share and
    // every seeded medication in the suite grows an offer card at once, in specs
    // that assert on the import page's geometry and never mention names.
    expect(shoutingWords("E2E Loratadine")).toEqual(["E2E"]);
    expect(isImportedDocumentName("E2E Loratadine")).toBe(false);
  });
});

describe("isCleanerName — what may be offered as a replacement", () => {
  const CURRENT = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";

  it("accepts an RxNorm preferred name", () => {
    expect(isCleanerName(CURRENT, "Calcium Carbonate / Cholecalciferol")).toBe(
      true
    );
  });

  it("refuses a candidate that is itself a document string", () => {
    // RxNorm returns product-level concepts and some of them shout. Trading a
    // document string for a document string is not a fix.
    expect(isCleanerName(CURRENT, "CALCIUM CARBONATE 500 MG TAB")).toBe(false);
  });

  it("refuses an empty or whitespace candidate", () => {
    expect(isCleanerName(CURRENT, "")).toBe(false);
    expect(isCleanerName(CURRENT, "   ")).toBe(false);
  });

  it("refuses a candidate that differs only in casing or padding", () => {
    expect(isCleanerName("Ibuprofen", "ibuprofen")).toBe(false);
    expect(isCleanerName("Ibuprofen", "  Ibuprofen ")).toBe(false);
  });
});
