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
    // AN ALL-CAPS SUPPLEMENT, pinned as a DECISION rather than left to drift. These
    // fire, and that is right: the scope gate means the predicate is only ever asked
    // about a row an IMPORT wrote, and in a portal document an all-caps rendering is
    // the document's own register. Nobody's typed supplement shelf reaches here.
    "FISH OIL",
    "MELATONIN",
    "CREATINE",
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
  //
  // AND IT COMES IN BOTH ORDERS. ISMP capitalises the DISTINGUISHING part of the
  // name, which is as often the stem as the tail — "DOPamine", "DOBUTamine",
  // "OXYcodone" are the canonical published renderings, and every one of them was
  // FALSE under a rule that demanded lower-case letters before the run. Half the
  // convention, and arguably the more important half, was invisible.
  const TALL_MAN: [string, string][] = [
    ["amLODIPine Besylate 5 MG tablet", "amLODIPine"],
    ["predniSONE 10 mg tablet", "predniSONE"],
    ["traMADol HCl 50 mg", "traMADol"],
    ["glipiZIDE 5 mg", "glipiZIDE"],
    ["hydrOXYzine 25 mg", "hydrOXYzine"],
    // The upper-case-STEM half of the convention.
    ["DOPamine 400 MG", "DOPamine"],
    ["DOBUTamine 250 MG", "DOBUTamine"],
    ["OXYcodone HCl 5 mg", "OXYcodone"],
    // THE TWO THE STEM ALTERNATIVE STILL MISSED, and both are canonical rather than
    // exotic. "OXcarbazepine" opens with a run of TWO, so a three-letter floor on the
    // leading run could never see it; "ePHEDrine" carries ONE lower-case letter
    // before its run, and it is rendered that way precisely to separate it from
    // "EPINEPHrine", which is the pair the convention exists for. A rule that missed
    // both while its comment said the convention was closed was claiming more than it
    // decided.
    ["OXcarbazepine 300 mg", "OXcarbazepine"],
    ["ePHEDrine sulfate 50 mg", "ePHEDrine"],
    ["EPINEPHrine 0.3 mg auto-injector", "EPINEPHrine"],
    ["rOPINIRole 1 mg", "rOPINIRole"],
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
    // lower-case letter with nothing lower-case after the run is the
    // "mRNA"/"GoLYTELY" shape; a one-letter lower-case tail is an abbreviation
    // wearing a plural ("NSAIDs", "MCTs", "IUs") or a salt suffix ("HCl").
    //
    // THE TRAILING FLOOR IS WHAT CARRIES THE UNIT SYMBOLS now that a leading run of
    // TWO is enough. "NaCl" is quiet because it opens with one capital, and "MG",
    // "MEq", "mEq", "mL", "IU" are quiet because nothing lower-case follows their
    // run — which matters more than it looks: "MG" appears in most of the positive
    // strings above, and a rule that read it as Tall Man would reach `true` on every
    // dispensing label off the wrong token.
    for (const name of [
      "CoQ10",
      "EpiPen",
      "NaCl",
      "mRNA vaccine",
      "GoLYTELY",
      "NSAIDs",
      "MCTs",
      "IUs",
      "Metformin HCl ER",
      "MG",
      "MEq",
      "mEq",
      "5 mL",
      "Vitamin D3 5000 IU",
      "MK-7",
    ])
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
    // THREE SHOUTED TOKENS AND NO STRENGTH — a front-of-bottle listing of actives,
    // which is one token from the shelf "EPA/DHA" sits on. "EPA/DHA" was quiet
    // because it has TWO shouted tokens, not because of the separator, so all three
    // of these fired under a bare three-token floor. What separates them from
    // "ASA 81 MG TAB" is that a dispensing label states a STRENGTH.
    "EPA DHA CLA",
    "MSM MCT ALA",
    "EPA/DHA/DPA",
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
    // AN ACCENTED LOWER-CASE LETTER IS A LETTER. The shout scan was `[A-Za-z]`-only
    // and the edge-punctuation trim was `[^A-Za-z0-9]`-only, so the leading "ü" was
    // stripped as though it were a bracket and "BERALL" read as a six-letter shout.
    "üBERALL",
    "ärztliche Verordnung",
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
