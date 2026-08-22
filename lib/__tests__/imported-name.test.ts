import { describe, expect, it } from "vitest";
import {
  isCleanerName,
  isImportedDocumentName,
  shoutingWords,
  tallManWords,
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
    // One shouted WORD — the drug's own name shouted, six letters or more.
    "PREDNISONE 10 mg",
    // A dose-form code beside a shouted brand.
    "EPIPEN 2-PAK",
    // The dispensing-label shape with no word long enough to carry it alone: a
    // name, a strength unit and a dose form, all abbreviated.
    "HCTZ 25 MG TAB",
    "ASA 81 MG TAB",
    "VIT D 1000 IU CAP",
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

describe("isImportedDocumentName — Tall Man lettering", () => {
  // THE REGISTER THIS FEATURE EXISTS FOR, and the one the first version of the rule
  // was inverted against: every name below was QUIET under a rule that measured how
  // much of the name shouts, because most of their letters are lower case. Tall Man
  // lettering is the ISMP look-alike convention and standard Epic/Cerner
  // medication-list output, so these are not an exotic corner — they are the
  // commonest thing a portal sends.
  const TALL_MAN: [string, string][] = [
    ["amLODIPine Besylate 5 MG tablet", "amLODIPine"],
    ["predniSONE 10 mg tablet", "predniSONE"],
    ["traMADol HCl 50 mg", "traMADol"],
    ["glipiZIDE 5 mg", "glipiZIDE"],
    ["hydrOXYzine 25 mg", "hydrOXYzine"],
  ];

  for (const [name, token] of TALL_MAN) {
    it(`sees ${JSON.stringify(name)}`, () => {
      // The token, not only the verdict: "amLODIPine Besylate 5 MG tablet" would
      // reach `true` off "MG" under a different rule, and that rule would then be
      // blind to "glipiZIDE 5 mg", which shouts nothing at all.
      expect(tallManWords(name)).toEqual([token]);
      expect(isImportedDocumentName(name)).toBe(true);
    });
  }

  it("does not read ordinary product spelling as Tall Man", () => {
    // One interior capital is a spelling ("CoQ10", "EpiPen"); one preceding
    // lower-case letter is the "mRNA"/"GoLYTELY" shape. Both floors are why the
    // benign list below stays quiet.
    for (const name of ["CoQ10", "EpiPen", "NaCl", "mRNA vaccine", "GoLYTELY"])
      expect(tallManWords(name), name).toEqual([]);
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
    // THE ABBREVIATION SHELF, and it is the reason the old share rule had to go: 17
    // of these 19 ordinary supplement names fired under it, every one of them
    // already the clearest form of its own name. A name that IS an abbreviation is
    // not a name being shouted, and no amount of "how much of this shouts" can tell
    // the two apart — the share of a bare acronym is 1.0 by construction.
    "NAC",
    "MSM",
    "DHEA",
    "GABA",
    "TUDCA",
    "PQQ",
    "NMN",
    "NR",
    "BCAA",
    "ALA",
    "5-HTP",
    "SAM-e",
    "EPA/DHA",
    "MCT oil",
    "CBD oil",
    "Omega-3 EPA DHA",
    "Fish oil EPA DHA",
    // The same abbreviations wearing a strength, which is how somebody writing one
    // down actually writes it.
    "DHEA 50 mg",
    "TUDCA 500 mg",
    "Vitamin K2 MK-7",
    "Creatine HCl",
    // THE DELIBERATE UNDER-MATCH, pinned so it is a decision and not a drift: a
    // short brand shouted on its own is the SAME SHAPE as "DHEA 50 mg" and stays
    // quiet. Missing an offer costs a person nothing; firing on their supplement
    // shelf costs them every future offer. With a dose form on the end — the way
    // portals usually write it — "HCTZ 25 MG TAB" is caught above.
    "HCTZ 25 mg",
    "ASA 81 mg",
    // What RxNorm answers with, which `isCleanerName` must be able to accept.
    "hydrochlorothiazide 25 MG oral tablet",
    "amlodipine besylate 5 MG oral tablet",
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
    // prefixed "E2E ", which IS a shouted token: two letters, and it is the only
    // one in the name. It stays quiet because two letters is an abbreviation
    // rather than a shouted word and one abbreviation is not a dispensing label.
    //
    // (An earlier version of this comment said "3 of its 13 letters shout, under
    // the 0.5 share". Both halves were wrong — the module's own letter count gives
    // 2 of 12 — and the share rule they described has since been removed. The
    // arithmetic is recorded here because a wrong number in the one place a future
    // reader would trust it is worse than no number.)
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
