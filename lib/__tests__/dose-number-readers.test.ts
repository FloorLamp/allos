import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readDoseQuantity,
  parseQuantity,
  doseUnitCount,
  WRITTEN_NUMBER,
  WRITTEN_NUMBER_SCAN,
  DOSE_NUMBER_SCAN,
} from "../dri";
import { readIngredientAmount } from "../intake-ingredients";
import {
  strengthFromName,
  cleanMedicationName,
  looksLikeDose,
  parsePrescription,
} from "../prescription-parse";
import { comparableNewStrength } from "../medication-renewal";
import { parseAmountMg } from "../prn-redose";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import {
  classifyDoseAmount,
  recoverableCandidates,
  preFixDoseReading,
} from "../dose-amount-census";
import { makeTmpDir } from "./tmp-dir";

// EVERY READER OF A WRITTEN NUMBER AGAINST A DOSE UNIT (#3444).
//
// #3319 stated the invariant this file enforces: "one rule for reading a written
// number, shared by both halves of a label". It was not true of the tree. There was a
// THIRD reader — lib/prescription-parse.ts, the one on the medication WRITE path — and
// it answered "5" to the question "what does 2,5 mean", stored that answer in
// intake_item_doses.amount, and left it sitting beside the honest name it contradicted.
//
// The mechanism is worth stating once, because it is what makes the failure class
// invisible and what the census below keys on. A number pattern that cannot span a
// separator does not REFUSE a comma decimal. The scan matches the digits before the
// comma, fails to find its unit, and RESTARTS one character later — where the digits
// after the comma match a unit perfectly. The reader returns a confident, well-formed,
// entirely wrong number. Refusal requires having the whole number in hand, which
// requires a pattern that spans the separator.
//
// Two halves, and both are needed:
//   * the BEHAVIOURAL sweep asks every reader what it makes of a comma decimal, and
//     insists on the label's number or nothing. It is immune to spelling but blind to
//     a reader nobody added to the list.
//   * the SOURCE census asks which patterns in the tree could restart mid-number. It
//     is blind to semantics but sees a reader added tomorrow.

// ─────────────────────────────────────────────────────────────────────────────
// The corpus. Every entry is a real European prescription spelling, with the dose the
// document states and the number the pre-#3444 tree produced instead.
// ─────────────────────────────────────────────────────────────────────────────
const CORPUS: {
  amount: string;
  trueMg: number | null;
  was: string;
  // See "THE NAME GRAMMAR IS EXEMPT" below — this entry's `or nothing` binds the dose
  // readers only, and the name splitter's actual answer is pinned separately.
  nameSplitterKeepsTheTail?: true;
}[] = [
  { amount: "2,5 mg", trueMg: 2.5, was: "5 mg" },
  { amount: "1,25 mg", trueMg: 1.25, was: "25 mg" },
  { amount: "0,125 mg", trueMg: 0.125, was: "125 mg" },
  { amount: "0,05 mg", trueMg: 0.05, was: "05 mg → 5" },
  { amount: "0,5 mg", trueMg: 0.5, was: "5 mg" },
  // A genuine thousands group: the one comma shape that MUST read, so that "refuse
  // anything with a comma" cannot pass this file.
  { amount: "1,000 mg", trueMg: 1000, was: "000 mg → 0" },
  // The NAKED DECIMAL — the same restart reached by dropping a character rather than
  // by changing one (#3444, second round).
  { amount: ".125 mg", trueMg: 0.125, was: "125 mg" },
  { amount: ",125 mg", trueMg: 0.125, was: "125 mg" },
  { amount: ".5 mg", trueMg: 0.5, was: "5 mg" },

  // ── #3451: the same restart reached through a separator that is not `.` or `,`. ──
  //
  // Each of these returned a confident ZERO from `readDoseQuantity` while
  // `readIngredientAmount` returned `unreadable` — one reader fabricating and the
  // other refusing, under a heading in lib/dri.ts claiming they agreed.
  //
  // `trueMg` is 1000 for the six spellings that can only be a thousands group, and
  // NULL for the plain ASCII space: on a label "1 500 mg" is as plausibly one 500 mg
  // tablet as it is fifteen hundred milligrams, so no reader may produce a number from
  // it. A null here is stricter than a value — it fails on ANY number, including the
  // 1000 a uniform fix would have returned.
  { amount: "1\u00a0000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u202f000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u2009000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u2007000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u2019000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u0027000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1\u066c000 mg", trueMg: 1000, was: "000 mg \u2192 0" },
  { amount: "1 000 mg", trueMg: null, was: "000 mg \u2192 0" },
  {
    amount: "2 500 mg",
    trueMg: null,
    nameSplitterKeepsTheTail: true,
    was: "500 mg \u2014 or 2500, and nobody can tell",
  },
];

// The quantity a reader's answer ultimately contributes to a total, whatever shape the
// reader returns it in. `null` means it contributed nothing — the honest outcome for a
// number nobody can read.
function contributedMg(answer: unknown): number | null {
  if (answer == null) return null;
  if (typeof answer === "number") return answer;
  if (typeof answer === "string") {
    const q = readDoseQuantity(answer);
    if (q.kind !== "quantity") return null;
    if (q.unit === "mg") return q.value;
    if (q.unit === "g") return q.value * 1000;
    if (q.unit === "mcg") return q.value / 1000;
    return null; // iu does not convert without knowing the substance
  }
  return null;
}

// Each reader in the tree that turns a dose string into a number, or into a string
// something else turns into a number. `read` returns whatever that reader answers;
// `contributedMg` above reduces it to the quantity that reaches a total.
const READERS: {
  name: string;
  read: (amount: string) => unknown;
  // Answers "where does the NAME end", not "what is this number" — see the exemption
  // and its pinned residual below.
  splitsNames?: true;
}[] = [
  { name: "dri.readDoseQuantity", read: (a) => a && parseQuantityMg(a) },
  { name: "dri.parseQuantity", read: (a) => parseQuantity(a)?.value ?? null },
  { name: "intake-ingredients.readIngredientAmount", read: readIngredientMg },
  {
    name: "prescription-parse.strengthFromName",
    read: strengthFromName,
    splitsNames: true,
  },
  {
    name: "prescription-parse.parsePrescription(name).strength",
    read: (a) => parsePrescription({ name: `Bisoprolol ${a}` }).strength,
    splitsNames: true,
  },
  {
    name: "prescription-parse.parsePrescription(sig).strength",
    read: (a) =>
      parsePrescription({
        name: "Bisoprolol",
        value: `Take ${a} by mouth daily`,
      }).strength,
  },
  {
    name: "medication-renewal.comparableNewStrength",
    read: comparableNewStrength,
    splitsNames: true,
  },
  { name: "prn-redose.parseAmountMg", read: parseAmountMg },
  {
    name: "medication-dose-format.formatMedicationDoseProduct",
    read: (a) => formatMedicationDoseProduct(a, null),
  },
];

function parseQuantityMg(amount: string): number | null {
  const q = readDoseQuantity(amount);
  return q.kind === "quantity" && q.unit === "mg" ? q.value : null;
}

function readIngredientMg(amount: string): number | null {
  const r = readIngredientAmount(amount);
  return r.kind === "quantity" && r.unit === "mg" ? r.amount : null;
}

describe("no reader of a dose amount invents a number (#3444)", () => {
  for (const c of CORPUS) {
    for (const reader of READERS) {
      if (c.nameSplitterKeepsTheTail && reader.splitsNames) continue;
      it(`${reader.name} on ${JSON.stringify(c.amount)} — ${c.trueMg} mg or nothing (was ${c.was})`, () => {
        const contributed = contributedMg(reader.read(c.amount));
        if (contributed !== null) expect(contributed).toBe(c.trueMg);
      });
    }
  }

  // THE NAME GRAMMAR IS EXEMPT FROM ONE CORPUS ENTRY, AND THE EXEMPTION IS PINNED HERE
  // RATHER THAN SKIPPED — an exclusion nobody can see is how a defect becomes a policy.
  //
  // `strengthFromName` and its two dependants answer "WHERE DOES THE NAME END", not
  // "what is this number". #3451 made the dose readers take "2 500" whole so they could
  // refuse it; making the NAME grammar do the same was measured and reverted, because it
  // moves the split on every drug whose name ends in a number — "Vitamin B 12",
  // "Sinemet 25", "Humulin 70 30" — and `medicationFamilies` then merges distinct drugs
  // into one redose family. Silent, and uncorrectable.
  //
  // So for a name like "Metformin 2 500 mg" the splitter still answers "500 mg", exactly
  // as on main. THAT IS A REAL REMAINING DEFECT, not a resolved one: if the label meant
  // 2500 mg it is a fivefold understatement, stated readably. It is unchanged from main,
  // it is the count-then-strength ambiguity ("one 500 mg tablet" is the other reading,
  // and 500 is the conservative of the two), and the ZERO case — which is the one #3451
  // was filed for — IS repaired, because a strength reading zero proves the split landed
  // mid-number and the splitter then extends left by exactly one digit run.
  it("the name splitter keeps a non-zero tail, and repairs a zero one", () => {
    // The residual, asserted so it cannot quietly become something else.
    expect(strengthFromName("Metformin 2 500 mg")).toBe("500 mg");
    expect(cleanMedicationName("Metformin 2 500 mg")).toBe("Metformin 2");
    // The repair, which is what #3451 asked for.
    expect(strengthFromName("Metformin 1 000 mg")).toBe("1 000 mg");
    expect(cleanMedicationName("Metformin 1 000 mg")).toBe("Metformin");
    // The repair extends AS FAR AS THE NUMBER GOES and never one group further. Both
    // directions matter and a single step gets only the first of them right:
    //   - a name's own trailing token must survive ("Vitamin B 12"), and
    //   - a number with more than two groups must be taken whole, or the name keeps a
    //     digit and the split is still wrong.
    expect(cleanMedicationName("Vitamin B 12 1 000 mcg")).toBe("Vitamin B 12");
    expect(strengthFromName("Vitamin B 12 1 000 mcg")).toBe("1 000 mcg");
    expect(cleanMedicationName("Metformin 1 000 000 mg")).toBe("Metformin");
    expect(strengthFromName("Metformin 1 000 000 mg")).toBe("1 000 000 mg");
    expect(cleanMedicationName("Metformin 1 000 000 000 mg")).toBe("Metformin");
    // A LEADING GROUP OF MORE THAN THREE DIGITS still extends — the middle groups are
    // shape-constrained, the leading one is not. Constraining it too was measured to
    // leave this one unextended, with a "000 mg" strength reading a confident zero.
    expect(cleanMedicationName("Metformin 1234 000 mg")).toBe("Metformin");
    expect(strengthFromName("Metformin 1234 000 mg")).toBe("1234 000 mg");
  });

  // A COUNT is a number against a dose unit too, and a fabricated count multiplies an
  // ingredient amount just as a fabricated mass does. `doseUnitCount`'s lookbehind is
  // what stops its scan restarting after the comma; without it "2,5 caps" would count
  // FIVE capsules and multiply every ingredient by five.
  it("doseUnitCount does not read a count out of the tail of a comma decimal", () => {
    expect(doseUnitCount("2,5 caps")).toBe(1);
    expect(doseUnitCount("0,125 tablets")).toBe(1);
    // The control: a real count still counts, so this is not passing by refusing
    // everything.
    expect(doseUnitCount("2 caps")).toBe(2);
    expect(doseUnitCount("3 tablets")).toBe(3);
  });

  // Grouping is the fourth surface the same grammar feeds. A strength welded to the
  // name means a later plain "Bisoprolol" starts a SECOND medication (#1204).
  it("cleanMedicationName strips a comma-decimal strength like any other", () => {
    expect(cleanMedicationName("Bisoprolol 2,5 mg")).toBe("Bisoprolol");
    expect(cleanMedicationName("Digoxin 0,125 mg")).toBe("Digoxin");
    expect(cleanMedicationName("albuterol (2,5 MG/3ML)")).toBe("albuterol");
    // Unchanged: a parenthetical with no digit+unit pair is an ingredient, not a
    // strength, and must survive.
    expect(cleanMedicationName("Tylenol (acetaminophen)")).toBe(
      "Tylenol (acetaminophen)"
    );
  });

  it("looksLikeDose accepts a comma decimal as the dose shape it is", () => {
    // It used to say NO, which routed "2,5 mg" to the sig and lost the strength
    // silently. Silent loss is better than a wrong number and worse than the truth.
    expect(looksLikeDose("2,5 mg")).toBe(true);
    expect(looksLikeDose("1,000 mg")).toBe(true);
    expect(looksLikeDose("Take one and see how you feel")).toBe(false);
  });

  // THE ONE READER THAT MUST KEEP THE OLD ANSWER, asserted rather than merely excluded.
  // `preFixDoseReading` exists to answer "what did this stored row read as BEFORE the
  // #3153 fix", so the retired pattern is its subject matter, not a defect in it. If
  // this ever starts agreeing with the corrected reader, the census silently loses the
  // ability to tell a repaired row from an untouched one.
  it("the census's pre-fix reader still reproduces the old wrong answers", () => {
    expect(preFixDoseReading("2,5 mg")).toEqual({ value: 5, unit: "mg" });
    expect(preFixDoseReading("0,125 mg")).toEqual({ value: 125, unit: "mg" });
    expect(preFixDoseReading("1,000 mg")).toEqual({ value: 0, unit: "mg" });
  });

  // A CANDIDATE IS OFFERED TO A PERSON, so a fabricated one is the worst output in this
  // file: a wrong dose with a confirm button beside it. `recoverableCandidates` had its
  // own unguarded scan and read ".125 mg" as a recoverable "125 mg" — the census
  // declaring a naked decimal repairable and proposing the exact thousandfold number.
  // Found by the DB tier, not by reading the code.
  it("never offers a candidate read out of the tail of a number", () => {
    for (const amount of [
      ".125 mg",
      ",125 mg",
      ".5 mg",
      "0,125 mg",
      "2,5 mg",
    ]) {
      expect(recoverableCandidates(amount)).toEqual([]);
      expect(classifyDoseAmount(amount)).toBe("unreadable-unrecoverable");
    }
    // THE CONTROL — a row that really does restate its dose still yields the candidate,
    // so this is not passing by refusing everything.
    expect(recoverableCandidates("2,5 g (2500 mg)")).toEqual(["2500 mg"]);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // THE CONSISTENCY HALF OF #3451.
  //
  // lib/dri.ts heads its grammar "ONE RULE FOR WHAT A SEPARATOR INSIDE A NUMBER
  // MEANS". A heading that overstates its reach is how the next person stops checking,
  // and it DID overstate: `readDoseQuantity("1\u2019000 mg")` was a confident 0 while
  // `readIngredientAmount("1\u2019000 mg")` was `unreadable`. The sweep above catches a
  // reader that INVENTS a number; it cannot catch two readers that merely DISAGREE,
  // because "the label's number or nothing" is satisfied by both answers.
  //
  // So this asks the question the heading actually makes: same string, same answer.
  // ─────────────────────────────────────────────────────────────────────────────
  const SEPARATORS: {
    sep: string;
    name: string;
    reads: 1000 | "unreadable";
  }[] = [
    { sep: ",", name: "U+002C comma (the control)", reads: 1000 },
    { sep: "\u00a0", name: "U+00A0 no-break space", reads: 1000 },
    { sep: "\u202f", name: "U+202F narrow no-break space", reads: 1000 },
    { sep: "\u2009", name: "U+2009 thin space", reads: 1000 },
    { sep: "\u2007", name: "U+2007 figure space", reads: 1000 },
    { sep: "\u2019", name: "U+2019 Swiss apostrophe", reads: 1000 },
    {
      sep: "\u0027",
      name: "U+0027 apostrophe (Swiss, ASCII keyboard)",
      reads: 1000,
    },
    { sep: "\u066c", name: "U+066C Arabic thousands separator", reads: 1000 },
    { sep: " ", name: "U+0020 space", reads: "unreadable" },
  ];

  for (const { sep, name, reads } of SEPARATORS) {
    it(`the dose half and the ingredient half agree about 1${sep}000 mg — ${name}`, () => {
      const dose = readDoseQuantity(`1${sep}000 mg`);
      const ingredient = readIngredientAmount(`1${sep}000 mg`);
      expect(dose.kind).toBe(ingredient.kind);
      if (reads === "unreadable") {
        expect(dose.kind).toBe("unreadable");
      } else {
        expect(dose).toEqual({ kind: "quantity", value: 1000, unit: "mg" });
        expect(ingredient).toEqual({
          kind: "quantity",
          amount: 1000,
          unit: "mg",
        });
      }
    });
  }

  // THE SECOND, INDEPENDENT WAY THE ROW WENT WRONG (#3451). The strength was not just
  // misread — it was CUT IN HALF, and the front half stayed welded to the name. A
  // "Metformin 1" never folds with the profile's other Metformin rows, so the same drug
  // appears twice and neither entry carries the whole dose.
  it("a space-grouped strength does not tear the drug name in half", () => {
    expect(cleanMedicationName("Metformin 1 000 mg")).toBe("Metformin");
    expect(strengthFromName("Metformin 1 000 mg")).toBe("1 000 mg");
    expect(cleanMedicationName("Metformin 1\u2019000 mg")).toBe("Metformin");
    expect(strengthFromName("Metformin 1\u2019000 mg")).toBe("1\u2019000 mg");
    // The controls. A name whose OWN digits precede the strength must keep them —
    // whether the digit is welded to a letter ("B12") or held by a hyphen ("Omega-3",
    // which is how this tree spells it, twenty times, and it never spells it with a
    // space).
    expect(cleanMedicationName("B12 500 mcg")).toBe("B12");
    expect(cleanMedicationName("CoQ10 200 mg")).toBe("CoQ10");
    expect(cleanMedicationName("Omega-3 1000 mg")).toBe("Omega-3");
    expect(cleanMedicationName("Vitamin D3 5000 IU")).toBe("Vitamin D3");
    // The en dash a document pipeline makes of that hyphen is on the same side.
    expect(cleanMedicationName(`Omega${"\u2013"}3 1000 mg`)).toBe(
      `Omega${"\u2013"}3`
    );

    // AND THE NAMES THAT USED TO BE THE COST OF THIS FIX, now asserted as KEPT.
    //
    // An interim revision let the NAME grammar span an unreadable separator run too, so
    // every name ending in a number lost its last token: "Omega 3", "Vitamin B 12",
    // "Sinemet 25", "PreserVision AREDS 2". That was disclosed as an acceptable cost on
    // the strength of it being "visible and correctable" — and it is neither, because
    // what it moves is the grouping KEY. `medicationFamilies` merged "Vitamin B 12",
    // "Vitamin B 6" and "Vitamin B 1" into ONE family, so a B6 dose armed the B12 redose
    // clock under a rendered claim that they share an active ingredient. Nothing renders
    // a key; nobody can correct one.
    //
    // The name grammar no longer spans, so all of these are main's answers again.
    expect(cleanMedicationName("Omega 3 1000 mg")).toBe("Omega 3");
    expect(cleanMedicationName("Vitamin B 12 1000 mcg")).toBe("Vitamin B 12");
    expect(cleanMedicationName("Vitamin B 6 100 mg")).toBe("Vitamin B 6");
    expect(cleanMedicationName("Sinemet 25 100 mg")).toBe("Sinemet 25");
    expect(cleanMedicationName("PreserVision AREDS 2 500 mg")).toBe(
      "PreserVision AREDS 2"
    );
    expect(cleanMedicationName("Humulin 70 30 100 units/mL")).toBe(
      "Humulin 70 30"
    );
    // THE WRITE PATH'S OWN COPY OF THE BINDER QUESTION (position 12). `strengthFromName`
    // carries its own lookbehind, a THIRD copy of "what binds a digit to a name" in a
    // second file — and spelled `(?<![A-Za-z0-9_])` it had no hyphen and no en dash, so
    // a hyphen-bound name digit regressed the STORED STRENGTH as well as the reading:
    // "Omega-3<NBSP>500 mg" yielded "3<NBSP>500 mg", which persistDocumentImport stores.
    // It derives from `NAME_BINDER_CHARS` now, like the other two.
    const NBSP = "\u00a0";
    expect(strengthFromName(`Omega-3${NBSP}500 mg`)).toBe("500 mg");
    expect(strengthFromName(`Vitamin B-12${NBSP}500 mcg`)).toBe("500 mcg");
    expect(strengthFromName(`Folic Acid B-9${NBSP}400 mcg`)).toBe("400 mcg");
    expect(strengthFromName(`Omega\u20133${NBSP}500 mg`)).toBe("500 mg");
    expect(strengthFromName(`Omega_3${NBSP}500 mg`)).toBe("500 mg");
    expect(strengthFromName(`Omega/3${NBSP}500 mg`)).toBe("500 mg");
    expect(strengthFromName(`Vitamin B/12${NBSP}500 mcg`)).toBe("500 mcg");
    // Controls: a plain space is unchanged, and so is a name with no binder at all.
    expect(strengthFromName("Omega-3 500 mg")).toBe("500 mg");
    expect(strengthFromName("Metformin 500 mg")).toBe("500 mg");

    // THE THREE KEYS THAT MUST STAY APART, which is the property the family merge broke.
    expect(
      new Set(
        [
          "Vitamin B 12 1000 mcg",
          "Vitamin B 6 100 mg",
          "Vitamin B 1 100 mg",
        ].map((n) => cleanMedicationName(n).toLowerCase())
      ).size
    ).toBe(3);
  });

  // A COUNT IS A NUMBER AGAINST A DOSE UNIT TOO, and the space branch sits directly on
  // top of the count-then-strength shape. `doseUnitCount` must not start reading a
  // count out of a group, and must keep reading the counts it always did.
  it("doseUnitCount is unmoved by a space-grouped amount", () => {
    expect(doseUnitCount("1 000 mg")).toBe(1);
    expect(doseUnitCount("1\u2019000 mg")).toBe(1);
    expect(doseUnitCount("2 capsules (500 mg)")).toBe(2);
    expect(doseUnitCount("2 caps")).toBe(2);
  });

  it("an unreadable comma decimal is bucketed as unreadable, not as correct", () => {
    for (const c of CORPUS.filter((x) => x.trueMg !== 1000)) {
      expect(classifyDoseAmount(c.amount)).toBe("unreadable-unrecoverable");
      // Nothing in the string restates the dose, so there is nothing to offer a person
      // as a candidate. A guess is not a candidate.
      expect(recoverableCandidates(c.amount)).toEqual([]);
    }
  });

  // THE CENSUS MUST STOP CERTIFYING THE ROW (#3451). It reported "1 000 mg" as
  // `always-correct` with no data-quality gap — honestly, by its own rule, because the
  // pre-fix reader and the shipped reader BOTH answered 0 and the census only asks
  // whether they agree. Two readers agreeing on a fabrication is not a clean row, and a
  // bucket that says otherwise is the loudest possible way to stop anyone looking.
  it("the dose-amount census no longer calls a space-grouped row always-correct", () => {
    expect(classifyDoseAmount("1 000 mg")).toBe("unreadable-unrecoverable");
    expect(classifyDoseAmount("2 500 mg")).toBe("unreadable-unrecoverable");
    // The six that now READ move to `recovered-from-zero` — the bucket whose whole
    // definition is "read as zero before the fix, correct now", which is exactly what
    // happened to them.
    for (const sep of [
      "\u00a0",
      "\u202f",
      "\u2009",
      "\u2007",
      "\u2019",
      "\u0027",
      "\u066c",
    ]) {
      expect(classifyDoseAmount(`1${sep}000 mg`)).toBe("recovered-from-zero");
    }
    // And the controls stay put, so this is not passing by reclassifying everything.
    expect(classifyDoseAmount("500 mg")).toBe("always-correct");
    expect(classifyDoseAmount("1 capsule")).toBe("no-quantity");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SOURCE CENSUS
//
// WHAT IT KEYS ON, and why that is the checkable question. Not "does this file spell
// the retired pattern" — the retired pattern is quoted in prose in at least three
// files that argue AGAINST it, and a census that cried wolf on those would be deleted
// within a week, taking the real guard with it. The defect needs TWO things at once:
//
//   1. a number pattern that cannot span `.` or `,` — so it stops mid-number; AND
//   2. NO ANCHOR — so the scan is free to restart after the separator it stopped at.
//
// An anchored pattern (`/^…/`) that cannot span a separator simply FAILS on "2,5 mg"
// and its caller gets null: a refusal, which is the safe direction and the behaviour
// four shipped readers already rely on. Only an unanchored one can hand back the tail
// of a number as if it were the whole number. That is why the census flags the pair
// rather than the pattern, and why the allow-list below has exactly one entry.
//
// WHAT THIS CENSUS CANNOT SEE, stated because a guard that implies a reach it lacks is
// worse than no guard — it turns "nobody has done this" into "nobody can do this", and
// only the first is true.
//
// IT CANNOT FOLLOW A COMPOSED GRAMMAR, WHICH IS HOW #3444 WAS ACTUALLY WRITTEN.
// lib/prescription-parse.ts did not put a number beside a unit in one literal. It
// declared `const NUM = String.raw`\d+(?:\.\d+)?`` on one line and a separate
// `DOSE_UNIT` on another, then composed them three constants later. Neither fragment
// carries both halves, so no text-matching census will ever pair them. MEASURED, not
// assumed: reverting NUM in the tree leaves this census green and reds NINETEEN
// assertions in the behavioural sweep above — which is the division of labour between
// the two halves, and the reason neither is optional. The reach test below pins the
// blind spot as a fixture so it stays known rather than becoming a surprise.
//
// PARTLY CLOSED SINCE #3468, and stated here because this header is where a reader
// looks: THE COMPOSED-SCAN CENSUS at the bottom of this file expands `${…}` from a
// file's own `const` definitions before asking its questions, so `const NUM =
// WRITTEN_NUMBER_SCAN` followed by `${NUM}` three constants later IS paired. It asks a
// different question from this one — WHICH SCAN a reader composed, and whether that
// scan can refuse — so neither census subsumes the other: this one sees a hand-written
// pattern that composes nothing, that one sees a composition whose text carries no
// number spelling at all. What remains out of reach for BOTH is a scan reached through
// a function, an object property or a renamed import.
//
// It also says nothing about a reader that does not use a regex at all (an indexOf, a
// hand-rolled character loop, a parseFloat over a substring). The behavioural sweep is
// the only half that can see those, and only for readers listed in it.
//
// THREE MORE LIMITS, FOUND BY FEEDING IT RESPELLINGS RATHER THAN BY READING IT. An
// adversarial pass handed this census fourteen plausible ways to write "scan for a
// number and a unit" and it missed thirteen. Three of those are now closed and named in
// the reach tests below — the bare `\d+`, the `new RegExp("…")` constructor form (which
// matters because this very fix is written that way), and `g` missing from the unit
// list even though `readDoseQuantity` accepts it. What remains open, so nobody has to
// rediscover it:
//
//   * A pattern assembled at RUNTIME from anything but a plain string literal — a
//     template with an interpolation, a variable, a `.source` splice. Same blind spot as
//     the composed grammar above, same reason: the text never exists in one place.
//   * A unit spelled some other way — "milligram", "MG." with a period, a localised
//     abbreviation. The list is the six `readDoseQuantity` accepts, and it is a list, not
//     a rule.
//   * Anything under e2e/ or in a test file, excluded by scope (see `trackedSources`).
//
// The honest summary is that this census raises the cost of reintroducing the defect in
// the shapes people actually write. It does not make the defect unreachable, and a
// reader who treats a green run here as proof of that will be wrong.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The spellings of "a number that cannot span a separator" that this repo actually
// uses or would plausibly reach for. Enumerated from the tree rather than from the
// issue: `\d+(?:\.\d+)?` is the one that shipped, and the others are the same thought
// written differently.
const NON_SPANNING_NUMBER = [
  String.raw`\d+(?:\.\d+)?`,
  String.raw`\d+(\.\d+)?`,
  String.raw`\d*(?:\.\d+)?`,
  String.raw`\d+\.?\d*`,
  String.raw`[0-9]+(?:\.[0-9]+)?`,
  String.raw`[0-9]+(\.[0-9]+)?`,
  // The SIMPLEST non-spanning scan, and the one most likely to be written by someone
  // who is not thinking about separators at all. It stops at a "." as surely as the
  // decorated spellings do, so on "2,5 mg" it matches the "5".
  String.raw`\d+`,
  String.raw`[0-9]+`,
];

// A number pattern that DOES span its separators still fabricates if the scan may begin
// after one — that is the naked-decimal half of #3444, and it is a different question
// from whether the number is spanning. `WRITTEN_NUMBER_SCAN` carries the guard; a
// hand-rolled spanning scan usually does not.
const SPANNING_NUMBER = [
  String.raw`\d+(?:[.,]\d+)*`,
  String.raw`\d+([.,]\d+)*`,
  String.raw`[0-9]+(?:[.,][0-9]+)*`,
];
const START_GUARD = String.raw`(?<![\d.,])`;

// A DOSE UNIT, not any word. A number followed by `[a-z]+` is a different question
// (`doseUnitCount` asks it, with its own lookbehind); a number followed by "mg" is a
// quantity someone will add up.
// `g` is in the list because `readDoseQuantity` accepts it — leaving it out was a hole
// the adversarial pass named. It is tested against the pattern BODY ONLY: a regex
// literal ends in its flags, and `/…/gi` would otherwise match on the `g` flag and
// report every global regex in the tree as a dose scan.
const DOSE_UNIT_TOKEN = /\b(?:mg|mcg|µg|ug|meq|iu|g)\b/i;

/**
 * Regex literals that pair a non-spanning number with a dose unit AND are not anchored
 * at the start of the pattern, keyed by file.
 *
 * ONE ENTRY, and it is the artifact the dose-amount census measures rather than a rule
 * anything reads with. Adding another means claiming a scan may restart in the middle
 * of a written number; say why in the value.
 */
const ALLOWED_UNANCHORED: Record<string, string> = {
  "lib/dose-amount-census.ts":
    "PRE_FIX_DOSE_RE is the RETIRED pattern, kept deliberately and only here so the " +
    "census can answer 'what did this stored row read as yesterday'. It is the " +
    "subject of a measurement, never a reader of live data — pinned by the " +
    "pre-fix-reader test above.",
};

function trackedSources(): string[] {
  return (
    execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx"], {
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\u0000")
      .filter(Boolean)
      // PRODUCTION READERS ONLY, and this is a scope statement rather than a convenience.
      // A dose is read for real in lib/, components/, app/ and scripts/; a spec file's
      // regexes assert on RENDERED COPY ("goal 120-150 g of protein"), which pairs a
      // number with a unit word and reads nothing. Including them made the census report a
      // protein nudge's assertion as a dosing defect, and a guard that cries wolf on
      // shipped code is removed within a week, taking the real guard with it. The cost is
      // real and stated: a dose reader living only in a test helper is outside this sweep,
      // as are this file's own fixtures.
      .filter(
        (f) =>
          !f.startsWith("e2e/") &&
          !f.includes("__tests__/") &&
          !f.includes("__db_tests__/") &&
          !/\.test\.tsx?$/.test(f)
      )
  );
}

/**
 * Source with comments blanked out. The retired pattern is QUOTED in the comments of
 * the very files that retired it — including this one — so a census that reads
 * comments reports its own documentation as a defect.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  let quote = "";
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (state === "code") {
      if (two === "//") {
        state = "line";
        i += 2;
        continue;
      }
      if (two === "/*") {
        state = "block";
        i += 2;
        continue;
      }
      if (source[i] === '"' || source[i] === "'") {
        state = "string";
        quote = source[i];
      } else if (source[i] === "`") {
        state = "template";
      }
      out += source[i++];
      continue;
    }
    if (state === "line") {
      if (source[i] === "\n") {
        state = "code";
        out += "\n";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (two === "*/") {
        state = "code";
        i += 2;
      } else {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      continue;
    }
    // Inside a string or template: copy through, honouring escapes, so a quote or a
    // backtick in the text cannot end it early.
    if (source[i] === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (state === "string" && source[i] === quote) ||
      (state === "template" && source[i] === "`")
    ) {
      state = "code";
    }
    out += source[i++];
  }
  return out;
}

/**
 * Every regex literal and String.raw template in the source, as text. Tolerant rather
 * than exact: a stray division that happens to look like a literal is harmless,
 * because only fragments carrying BOTH a number pattern and a dose unit are examined.
 */
function patternFragments(code: string): string[] {
  const out: string[] = [];
  const literal =
    /\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[dgimsuvy]*/g;
  // The BODY only — the trailing flags are not part of the pattern, and `g` is a unit.
  for (const m of code.matchAll(literal))
    out.push(m[0].replace(/\/[dgimsuvy]*$/, "/"));
  const raw = /String\.raw`(?:[^`\\]|\\.)*`/g;
  for (const m of code.matchAll(raw)) out.push(m[0]);
  // `new RegExp("…")` with an ORDINARY string literal, where every backslash is
  // doubled. Missed until the adversarial pass pointed out that this very PR builds its
  // patterns with `new RegExp`, so the constructor form is exactly the one a reader
  // would reach for next.
  const ctor = /new RegExp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const m of code.matchAll(ctor)) out.push(m[1].replace(/\\\\/g, "\\"));
  return out;
}

/** Does this pattern start by anchoring? `/^…/` or `/(?:^…/` or `/(^…/`. */
function isAnchored(fragment: string): boolean {
  const body = fragment.startsWith("String.raw")
    ? fragment.slice("String.raw`".length)
    : fragment.slice(1);
  return /^(?:\((?:\?:|\?<[^>]+>)?)*\^/.test(body);
}

export function unanchoredDoseScans(code: string): string[] {
  return patternFragments(code).filter((fragment) => {
    if (!DOSE_UNIT_TOKEN.test(fragment)) return false;
    if (isAnchored(fragment)) return false;

    const spans = SPANNING_NUMBER.some((n) => fragment.includes(n));

    // A SPANNING TOKEN IS REMOVED BEFORE LOOKING FOR A NON-SPANNING ONE, because
    // `\d+(?:[.,]\d+)*` CONTAINS the literal `\d+`. Testing for the bare spelling
    // without this step reports every correct pattern in the tree as defective — which
    // is not a small false positive but an inverted census, green on the defect and red
    // on the fix.
    let rest = fragment;
    for (const n of SPANNING_NUMBER) rest = rest.split(n).join("");
    const nonSpanning = NON_SPANNING_NUMBER.some((n) => rest.includes(n));

    // Either half of the defect: a number that cannot span a separator at all, or one
    // that can but whose scan may still begin after one (the naked decimal).
    return nonSpanning || (spans && !fragment.includes(START_GUARD));
  });
}

describe("the unanchored-dose-scan census (#3444)", () => {
  const scanned = trackedSources();
  const found = new Map<string, string[]>();
  for (const relative of scanned) {
    const hits = unanchoredDoseScans(
      stripComments(readFileSync(path.join(REPO, relative), "utf8"))
    );
    if (hits.length > 0) found.set(relative, hits);
  }

  // A SWEEP OVER NOTHING IS GREEN. The file list comes from a subprocess whose output
  // format this test has to agree with, and if that agreement ever breaks the census
  // reports a clean tree it never opened. So it states its own reach, and names two
  // files it must have read — one per directory it claims to cover.
  it("actually opened the tree it claims to have swept", () => {
    expect(scanned.length).toBeGreaterThan(1000);
    expect(scanned).toContain("lib/prescription-parse.ts");
    expect(scanned).toContain(
      "components/medications/PediatricDoseBandPicker.tsx"
    );
  });

  it("finds no unanchored dose scan outside the registry", () => {
    const unregistered = [...found]
      .filter(([relative]) => !(relative in ALLOWED_UNANCHORED))
      .map(
        ([relative, hits]) =>
          `${relative}: ${hits.join(" | ")} — this pattern cannot span a "," or ".", ` +
          `and nothing anchors it, so on "2,5 mg" it will match the "5" and return a ` +
          `confident WRONG number. Build it from WRITTEN_NUMBER (lib/dri.ts) and let ` +
          `readGroupedNumber decide what it means, or anchor it so it refuses.`
      );
    expect(unregistered).toEqual([]);
  });

  it("keeps the registry from outliving the patterns it excuses", () => {
    expect([...found.keys()].sort()).toEqual(
      Object.keys(ALLOWED_UNANCHORED).sort()
    );
  });
});

describe("the census's reach", () => {
  // A green sweep over a complying tree says NOTHING about what the sweep can see, so
  // it is run over sources written to break it — and over the benign neighbours it must
  // stay silent on, since a guard that cries wolf on shipped code gets deleted.
  const dir = makeTmpDir("dose-scan-census");
  const scan = (name: string, content: string): string[] => {
    writeFileSync(path.join(dir, name), content);
    return unanchoredDoseScans(
      stripComments(readFileSync(path.join(dir, name), "utf8"))
    );
  };

  it("SEES the exact defect this issue was filed for", () => {
    // lib/prescription-parse.ts, as it shipped.
    expect(
      scan(
        "shipped.ts",
        "const Q = String.raw`\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|iu)`;\n"
      )
    ).toHaveLength(1);
    // The same thought as a plain literal, which is how four other files write it.
    expect(
      scan(
        "literal.ts",
        "const RE = /(\\d+(?:\\.\\d+)?)\\s*(mg|mcg|ug)\\b/i;\n"
      )
    ).toHaveLength(1);
  });

  it("SEES the alternative spellings, not just the one the issue named", () => {
    expect(
      scan("variants.ts", "const A = /(\\d+\\.?\\d*)\\s*mg/i;\n")
    ).toHaveLength(1);
    expect(
      scan("charclass.ts", "const B = /([0-9]+(?:\\.[0-9]+)?)\\s*mcg/;\n")
    ).toHaveLength(1);
    expect(
      scan("uncaptured.ts", "const C = /\\d+(\\.\\d+)?\\s*IU/i;\n")
    ).toHaveLength(1);
  });

  it("STAYS SILENT on an anchored pattern, which refuses instead of restarting", () => {
    // prn-redose, medication-dose-format, medication-renewal and the pediatric picker
    // all look like this. They return null on "2,5 mg" — safe, and not this defect.
    expect(
      scan("anchored.ts", "const RE = /^(\\d+(?:\\.\\d+)?)\\s*mg$/i;\n")
    ).toEqual([]);
    expect(
      scan(
        "anchored-group.ts",
        "const RE = /^(?:(\\d+(?:\\.\\d+)?)\\s*(mg|iu))/i;\n"
      )
    ).toEqual([]);
  });

  it("STAYS SILENT on a spanning pattern that also GUARDS ITS START — the whole fix", () => {
    expect(
      scan(
        "spanning.ts",
        "const RE = /(?<![\\d.,])[.,]?(\\d+(?:[.,]\\d+)*)\\s*(mg|mcg|iu)\\b/i;\n"
      )
    ).toEqual([]);
  });

  it("SEES a spanning pattern whose scan may still start after a separator", () => {
    // The naked-decimal half. This one reads "2,5 mg" correctly and STILL reads
    // ".125 mg" as 125, because nothing stops the match beginning at the "1". It is the
    // shape `recoverableCandidates` shipped with, and the shape the first round of this
    // PR would have left behind.
    expect(
      scan(
        "unguarded.ts",
        "const RE = /(\\d+(?:[.,]\\d+)*)\\s*(mg|mcg|iu)\\b/gi;\n"
      )
    ).toHaveLength(1);
  });

  it("SEES the constructor form, which is how this fix itself is written", () => {
    expect(
      scan(
        "ctor.ts",
        'const RE = new RegExp("(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*(mg|mcg|iu)", "i");\n'
      )
    ).toHaveLength(1);
  });

  it("SEES a bare digit-plus scan, the simplest non-spanning spelling of all", () => {
    expect(
      scan("bare.ts", "const RE = /(\\d+)\\s*(mg|mcg|iu)\\b/i;\n")
    ).toHaveLength(1);
  });

  it("STAYS SILENT on the retired pattern QUOTED IN A COMMENT to argue against it", () => {
    // Three shipped files do exactly this, including the one this census lives beside.
    // Reading comments would turn every explanation of the bug into a report of it.
    expect(
      scan(
        "comment.ts",
        [
          "// The scan used to read `\\d+(?:\\.\\d+)?` against (mg|mcg|iu), which could",
          "// not span a comma. Do not reintroduce it.",
          "const RE = /(?<![\\d.,])[.,]?(\\d+(?:[.,]\\d+)*)\\s*(mg|iu)\\b/i;",
          "",
        ].join("\n")
      )
    ).toEqual([]);
    expect(
      scan(
        "block-comment.ts",
        "/* \\d+(?:\\.\\d+)? beside mg, in prose */\nconst n = 1;\n"
      )
    ).toEqual([]);
  });

  it("is BLIND to a grammar composed from constants — the shape #3444 actually took", () => {
    // Not a wish: this is lib/prescription-parse.ts as it shipped, reduced. The number
    // and the unit never meet in one fragment, so the pair this census keys on does not
    // exist in the text. Pinned as a fixture so the limitation is a known quantity —
    // the behavioural sweep at the top of this file is what covers it, and reverting
    // NUM in the real tree reds nineteen of its assertions while leaving this census
    // green.
    expect(
      scan(
        "composed.ts",
        [
          "const NUM = String.raw`\\d+(?:\\.\\d+)?`;",
          "const DOSE_UNIT = String.raw`(?:(?:mg|mcg|iu)\\b|%)`;",
          "const QUANTITY = String.raw`${NUM}\\s*${DOSE_UNIT}`;",
          "",
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("STAYS SILENT on a number scan with no dose unit anywhere near it", () => {
    // normalizeAge parses "6 months"; reference-range parses "12.5-15.0". Both spell
    // the same number pattern, neither feeds a dose total, and flagging them would be
    // the census claiming a scope it does not have.
    expect(
      scan("age.ts", "const RE = /^(\\d+(?:\\.\\d+)?)\\s*([a-z\\s./-]*)$/;\n")
    ).toEqual([]);
    expect(
      scan(
        "range.ts",
        "const RE = /(-?\\d+(?:\\.\\d+)?)\\s*(?:-|to)\\s*(-?\\d+(?:\\.\\d+)?)/i;\n"
      )
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSED-SCAN CENSUS (#3468)
//
// #3464 SPLIT THE SCAN IN TWO, AND THE TEXT CENSUS ABOVE CANNOT TELL THEM APART.
//
//   WRITTEN_NUMBER_SCAN  where a number starts and ends for a NAME GRAMMAR. It does
//                        not span an unreadable separator run, on purpose: spanning it
//                        collapses "Vitamin B 12" to "Vitamin B" and makes
//                        `medicationFamilies` merge distinct drugs into one redose
//                        family.
//   DOSE_NUMBER_SCAN     the same plus the refusal branch, for readers whose answer is
//                        a QUANTITY and whose safe fallback is refusal.
//
// A new dose reader that composes WRITTEN_NUMBER_SCAN — the wrong one, and the one with
// the more inviting name — is spanning AND start-guarded, so `unanchoredDoseScans` above
// stays silent on it. The reader it describes returns a CONFIDENT ZERO for "1 000 mg"
// and every other unreadable-run spelling, which is the whole of what #3451 was for.
//
// SO THIS ONE KEYS ON A PROPERTY, NOT AN ENUMERATION. There is no list of "the
// unreadable separators" left to widen to — since #3464 the shipped rule is DERIVED,
// refusing any separator run that is not one of four meaning-carrying characters — and
// enumerating that complement is the exact mistake #3464 made three times before
// inverting the classes. The property here is the one that matters to a caller:
//
//     CAN THE READER REFUSE? A scan can refuse only if it takes an unreadable run
//     WHOLE, because that is what leaves `readGroupedNumber` something to decline. A
//     scan that stops at the space hands its caller the fragment before it and the
//     caller answers confidently.
//
// That is asked of the scan's BEHAVIOUR, at runtime, against "1 000" — not of its text.
// So a fourth scan classifies itself, and a scan whose guards change is re-classified
// by the same question rather than by anyone remembering to update a list.
//
// AND IT FOLLOWS ONE LEVEL OF COMPOSITION, which is the reach #3444 named as missing.
// lib/prescription-parse.ts writes `const NUM = WRITTEN_NUMBER_SCAN;` and composes NUM
// three constants later; nothing that matches on a fragment in isolation will ever pair
// them. Interpolations are EXPANDED from the file's own `const` definitions before the
// questions are asked, so an alias is transparent and the dose unit hiding behind
// `${DOSE_UNIT}` is visible.
//
// THE TWO REGISTRIES BELOW ARE CLASSIFICATIONS, NOT AN OCCURRENCE ALLOWLIST, and the
// difference is why they earn their keep. Neither lists PLACES the defect is tolerated.
// `NOT_A_NUMBER_SCAN` answers "is this export a number a reader returns?" — a question
// about what a constant IS, asked once of each thing lib/dri.ts publishes, and the
// answer does not change as the tree moves. `ALLOWED_NON_REFUSING` answers "is this a
// name grammar or a quantity reader?" — the distinction #3464 created and the exact
// distinction this census exists to be able to draw. Both are ONE entry.
//
// So do not delete them as ratchet machinery, and do not grow them as one either. A
// second entry in `ALLOWED_NON_REFUSING` is a claim that another module's answer is a
// NAME and not a QUANTITY; if that is not true of it, the reader is the defect and the
// registry is not where it belongs.
//
// WHAT IS STILL OUT OF REACH, in the register this file already uses:
//   * a scan reached through a FUNCTION, an object property or an import alias
//     (`import { WRITTEN_NUMBER_SCAN as N }`) — expansion follows plain `const X = Y;`
//     and `const X = String.raw\`…\`;`, nothing else;
//   * a reader that composes nothing and hand-writes the guard — that is the text
//     census above's question, and it is why both exist;
//   * a reader that uses no regex at all. The behavioural sweep at the top of this file
//     is the only half that can see those, and only for the readers listed in it.
// ─────────────────────────────────────────────────────────────────────────────

/** The scans lib/dri.ts publishes for other modules to compose AS A NUMBER. */
const SCAN_SOURCES: Record<string, string> = {
  WRITTEN_NUMBER,
  WRITTEN_NUMBER_SCAN,
  DOSE_NUMBER_SCAN,
};

/**
 * The other `*NUMBER*` exports of lib/dri.ts, which are not scans a reader composes as
 * its number — so "can it refuse" is not a question about them.
 *
 * This registry exists because the classification above is only honest if it covers
 * EVERYTHING the module publishes. A new export that nothing classifies would sit
 * outside the census silently, which is the shape this whole file refuses. Writing the
 * sentence is the cost of adding one; it was found by this guard on its first run.
 */
const NOT_A_NUMBER_SCAN: Record<string, string> = {
  MID_NUMBER_PREFIX:
    "an END-anchored test on the text BEFORE a strength, asking how far back a " +
    "number goes so a name/strength split can be walked out of the middle of one. " +
    "It never stands in for the number a reader returns, and its one consumer " +
    "(lib/prescription-parse.ts) matches it against a prefix, not against a dose.",
};

/**
 * The string every one of these scans is classified against.
 *
 * A plain space between digit groups: the spelling #3451 was filed for, and the one
 * separator run that is unreadable no matter which of the four meaning-carrying
 * characters a document uses.
 */
const UNREADABLE_RUN = "1 000";

/**
 * Can a reader built on this scan REFUSE?
 *
 * Only if the scan takes the whole unreadable run, because that is what reaches
 * `readGroupedNumber` with something to decline. A scan that stops at the space
 * returns "1" and its caller answers 1 — or, one restart later, 0.
 */
function canRefuse(scanSource: string): boolean {
  return new RegExp(scanSource).exec(UNREADABLE_RUN)?.[0] === UNREADABLE_RUN;
}

/** The body of a pattern fragment, without its `/…/` or `String.raw\`…\`` wrapper. */
function fragmentBody(fragment: string): string {
  if (fragment.startsWith("String.raw`"))
    return fragment.slice("String.raw`".length, -1);
  if (fragment.startsWith("/") && fragment.endsWith("/"))
    return fragment.slice(1, -1);
  return fragment;
}

/**
 * A file's own `const` definitions, in the two shapes an interpolation can resolve to.
 *
 * A plain alias (`const NUM = WRITTEN_NUMBER_SCAN;`) is stored as `${WRITTEN_NUMBER_SCAN}`
 * so the SAME expansion loop resolves it — one mechanism, not two.
 */
function constTexts(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /const\s+([A-Za-z0-9_$]+)\s*=\s*(String\.raw`(?:[^`\\]|\\.)*`|[A-Za-z0-9_$]+)\s*;/g;
  for (const m of code.matchAll(re)) {
    out.set(
      m[1],
      m[2].startsWith("String.raw`")
        ? m[2].slice("String.raw`".length, -1)
        : `\${${m[2]}}`
    );
  }
  return out;
}

/** Expand `${…}` from the file's constants, recording which SCANS were reached. */
function expandFragment(
  body: string,
  defs: Map<string, string>
): { text: string; scans: Set<string> } {
  const scans = new Set<string>();
  let text = body;
  // Bounded: a cycle (`const A = B; const B = A;`) must not hang the tier, and real
  // chains in this tree are two or three deep.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    text = text.replace(/\$\{([A-Za-z0-9_$]+)\}/g, (whole, name: string) => {
      if (Object.hasOwn(SCAN_SOURCES, name)) {
        scans.add(name);
        changed = true;
        return SCAN_SOURCES[name];
      }
      const def = defs.get(name);
      if (def === undefined) return whole;
      changed = true;
      return def;
    });
    if (!changed) break;
  }
  return { text, scans };
}

/** Is this EXPANDED pattern body anchored at the start? */
function bodyIsAnchored(body: string): boolean {
  return /^(?:\((?:\?:|\?<[^>]+>)?)*\^/.test(body);
}

/**
 * Every pattern that composes a scan which CANNOT refuse, against a dose unit, without
 * an anchor to make it fail instead.
 */
export function nonRefusingDoseComposers(code: string): string[] {
  const defs = constTexts(code);
  const out: string[] = [];
  for (const fragment of patternFragments(code)) {
    const { text, scans } = expandFragment(fragmentBody(fragment), defs);
    const cannotRefuse = [...scans].filter((n) => !canRefuse(SCAN_SOURCES[n]));
    if (cannotRefuse.length === 0) continue;
    if (!DOSE_UNIT_TOKEN.test(text)) continue;
    if (bodyIsAnchored(text)) continue;
    out.push(`${fragment} composes ${cannotRefuse.sort().join(", ")}`);
  }
  return out;
}

/**
 * Files allowed to compose a non-refusing scan against a dose unit. One entry, and it
 * is the NAME GRAMMAR the split exists for — say why in the value.
 */
const ALLOWED_NON_REFUSING: Record<string, string> = {
  "lib/prescription-parse.ts":
    "a NAME grammar, not a quantity reader. Its answer is where a drug name ends and " +
    "its strength begins, and WRITTEN_NUMBER_SCAN is the correct half precisely " +
    "because it does NOT span an unreadable run: spanning it collapses " +
    '"Vitamin B 12" to "Vitamin B" and merges distinct drugs into one redose family. ' +
    "The strength it splits off is handed to readDoseQuantity, which composes the " +
    "refusing scan — so the refusal still happens, one module later.",
};

describe("the composed-scan census (#3468)", () => {
  const scanned = trackedSources();
  const found = new Map<string, string[]>();
  for (const relative of scanned) {
    const hits = nonRefusingDoseComposers(
      stripComments(readFileSync(path.join(REPO, relative), "utf8"))
    );
    if (hits.length > 0) found.set(relative, hits);
  }

  it("classifies the shipped scans by whether their reader CAN REFUSE", () => {
    // The property this census keys on, stated as an assertion so it cannot quietly
    // invert. `1 000` is the unreadable run; the refusing scan takes it whole and hands
    // readGroupedNumber something to decline, the name-grammar scan stops at the space.
    expect(canRefuse(DOSE_NUMBER_SCAN)).toBe(true);
    expect(canRefuse(WRITTEN_NUMBER_SCAN)).toBe(false);
    expect(canRefuse(WRITTEN_NUMBER)).toBe(false);
    // And the consequence, at the reader: the refusing composition declines rather
    // than answering, which is what "confident zero" would otherwise be.
    expect(readDoseQuantity("1 000 mg").kind).toBe("unreadable");
  });

  it("knows every scan lib/dri.ts publishes, so a fourth must be classified", () => {
    // The registry's premise. A new exported *NUMBER* scan that nothing classifies
    // would sit outside SCAN_SOURCES and be invisible to the census — silence that
    // reads as coverage, which is the defect this whole file exists to refuse. Either
    // it is a scan a reader composes as its number (SCAN_SOURCES, and `canRefuse`
    // classifies it by running it) or it is not (NOT_A_NUMBER_SCAN, with a sentence).
    const exported = [
      ...stripComments(
        readFileSync(path.join(REPO, "lib/dri.ts"), "utf8")
      ).matchAll(/^export const ([A-Z0-9_]*NUMBER[A-Z0-9_]*)\s*=/gm),
    ].map((m) => m[1]);
    expect(exported.sort()).toEqual(
      [...Object.keys(SCAN_SOURCES), ...Object.keys(NOT_A_NUMBER_SCAN)].sort()
    );
  });

  it("finds no non-refusing dose composer outside the registry", () => {
    const unregistered = [...found]
      .filter(([relative]) => !(relative in ALLOWED_NON_REFUSING))
      .map(
        ([relative, hits]) =>
          `${relative}: ${hits.join(" | ")} — this reader composes a scan that CANNOT ` +
          `refuse, against a dose unit, unanchored. On "1 000 mg" the scan stops at ` +
          `the space and the reader answers confidently with the fragment before it. ` +
          `Compose DOSE_NUMBER_SCAN (lib/dri.ts) if the answer is a QUANTITY, or say ` +
          `in ALLOWED_NON_REFUSING why a name grammar is the right half here.`
      );
    expect(unregistered).toEqual([]);
  });

  it("keeps THAT registry from outliving the readers it excuses", () => {
    expect([...found.keys()].sort()).toEqual(
      Object.keys(ALLOWED_NON_REFUSING).sort()
    );
  });

  it("is SILENT on the two neighbours #3468 named by hand", () => {
    // Both are the cry-wolf cases: shipped code that is correct, and that a census
    // keyed one notch wider would report. Named individually rather than left to the
    // set equality above, because they are the two the issue asked about.
    //
    // lib/dose-amount-census.ts composes the REFUSING scan for its live reader, and
    // its retired PRE_FIX_DOSE_RE composes nothing at all — it is a bare literal, the
    // subject of a measurement rather than a reader of live data.
    expect(found.has("lib/dose-amount-census.ts")).toBe(false);
    expect(preFixDoseReading("1 000 mg")).not.toBeNull();
    // …and lib/prescription-parse.ts IS found, then excused by name. Asserting the
    // finding rather than only the excuse keeps the entry from becoming decoration:
    // if that file stopped composing the name grammar, this is what would say so.
    expect(found.get("lib/prescription-parse.ts")?.length).toBeGreaterThan(0);
  });
});

describe("the composed-scan census's reach", () => {
  const dir = makeTmpDir("composed-scan-census");
  const scan = (name: string, content: string): string[] => {
    writeFileSync(path.join(dir, name), content);
    return nonRefusingDoseComposers(
      stripComments(readFileSync(path.join(dir, name), "utf8"))
    );
  };

  it("FLAGS a dose reader built on WRITTEN_NUMBER_SCAN", () => {
    // The source #3468 describes: the wrong scan, the more inviting name, and a
    // confident zero for every unreadable-run spelling. `unanchoredDoseScans` above
    // is silent on this exact text — asserted here so the two halves' division of
    // labour is a measurement rather than a claim.
    const src =
      "import { WRITTEN_NUMBER_SCAN } from './dri';\n" +
      "const RE = new RegExp(String.raw`(${WRITTEN_NUMBER_SCAN})\\s*(mg|mcg)\\b`, 'i');\n";
    expect(scan("wrong-scan.ts", src)).toHaveLength(1);
    expect(unanchoredDoseScans(stripComments(src))).toEqual([]);
  });

  it("FLAGS it through a LOCAL ALIAS, which is how the tree actually writes it", () => {
    // `const NUM = WRITTEN_NUMBER_SCAN;` then `${NUM}` three constants later — the
    // composed-grammar shape #3444 was written in and that no fragment-in-isolation
    // census can pair. The unit hides behind an alias too.
    expect(
      scan(
        "aliased.ts",
        "import { WRITTEN_NUMBER_SCAN } from './dri';\n" +
          "const NUM = WRITTEN_NUMBER_SCAN;\n" +
          "const UNIT = String.raw`(?:mg|mcg|iu)\\b`;\n" +
          "const RE = new RegExp(String.raw`\\s+${NUM}\\s*${UNIT}.*$`, 'i');\n"
      )
    ).toHaveLength(1);
  });

  it("STAYS SILENT on a reader that composes the REFUSING scan", () => {
    // lib/dri.ts's own DOSE_QUANTITY_RE and lib/dose-amount-census.ts, in miniature.
    expect(
      scan(
        "right-scan.ts",
        "import { DOSE_NUMBER_SCAN } from './dri';\n" +
          "const RE = new RegExp(String.raw`(${DOSE_NUMBER_SCAN})\\s*(mcg|mg|g|iu)\\b`, 'i');\n"
      )
    ).toEqual([]);
  });

  it("STAYS SILENT on an ANCHORED composition, which refuses by failing", () => {
    // lib/intake-ingredients.ts, which composes WRITTEN_NUMBER on purpose and anchors
    // both ends: "1 000 mg" matches nothing and the caller gets null.
    expect(
      scan(
        "anchored-compose.ts",
        "import { WRITTEN_NUMBER } from './dri';\n" +
          "const RE = new RegExp(String.raw`^(${WRITTEN_NUMBER})\\s*(mcg|mg|g|iu)$`, 'i');\n"
      )
    ).toEqual([]);
  });

  it("STAYS SILENT on a name grammar with no dose unit in it", () => {
    // Splitting a name on a number is not reading a quantity. Flagging it would be the
    // cry-wolf direction on the very use the scan split exists to serve.
    expect(
      scan(
        "name-only.ts",
        "import { WRITTEN_NUMBER_SCAN } from './dri';\n" +
          "const RE = new RegExp(String.raw`^(.*?)\\s+${WRITTEN_NUMBER_SCAN}$`);\n"
      )
    ).toEqual([]);
  });

  it("STAYS SILENT on prose that merely NAMES the wrong scan", () => {
    // Three files in this tree discuss WRITTEN_NUMBER_SCAN in order to explain which
    // half to use. A census that reported them would be a list of documentation.
    expect(
      scan(
        "prose.ts",
        "// Do not build a quantity reader on WRITTEN_NUMBER_SCAN against mg — it\n" +
          "// cannot refuse. Compose DOSE_NUMBER_SCAN instead.\n" +
          "export const NOTE = 1;\n"
      )
    ).toEqual([]);
  });
});
