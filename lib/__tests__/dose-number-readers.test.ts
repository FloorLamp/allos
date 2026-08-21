import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readDoseQuantity, parseQuantity, doseUnitCount } from "../dri";
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
  { amount: "2 500 mg", trueMg: null, was: "500 mg \u2014 or 2500, and nobody can tell" },
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
const READERS: { name: string; read: (amount: string) => unknown }[] = [
  { name: "dri.readDoseQuantity", read: (a) => a && parseQuantityMg(a) },
  { name: "dri.parseQuantity", read: (a) => parseQuantity(a)?.value ?? null },
  { name: "intake-ingredients.readIngredientAmount", read: readIngredientMg },
  { name: "prescription-parse.strengthFromName", read: strengthFromName },
  {
    name: "prescription-parse.parsePrescription(name).strength",
    read: (a) => parsePrescription({ name: `Bisoprolol ${a}` }).strength,
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
      it(`${reader.name} on ${JSON.stringify(c.amount)} — ${c.trueMg} mg or nothing (was ${c.was})`, () => {
        const contributed = contributedMg(reader.read(c.amount));
        if (contributed !== null) expect(contributed).toBe(c.trueMg);
      });
    }
  }

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
  const SEPARATORS: { sep: string; name: string; reads: 1000 | "unreadable" }[] = [
    { sep: ",", name: "U+002C comma (the control)", reads: 1000 },
    { sep: "\u00a0", name: "U+00A0 no-break space", reads: 1000 },
    { sep: "\u202f", name: "U+202F narrow no-break space", reads: 1000 },
    { sep: "\u2009", name: "U+2009 thin space", reads: 1000 },
    { sep: "\u2007", name: "U+2007 figure space", reads: 1000 },
    { sep: "\u2019", name: "U+2019 Swiss apostrophe", reads: 1000 },
    { sep: "\u0027", name: "U+0027 apostrophe (Swiss, ASCII keyboard)", reads: 1000 },
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
    // The controls. A name whose OWN digits precede the strength must keep them, and a
    // second group of four digits is not a thousands group at all.
    expect(cleanMedicationName("B12 500 mcg")).toBe("B12");
    expect(cleanMedicationName("CoQ10 200 mg")).toBe("CoQ10");
    expect(cleanMedicationName("Omega 3 1000 mg")).toBe("Omega 3");
    expect(cleanMedicationName("Vitamin D3 5000 IU")).toBe("Vitamin D3");
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
    for (const sep of ["\u00a0", "\u202f", "\u2009", "\u2007", "\u2019", "\u0027", "\u066c"]) {
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "dose-scan-census-"));
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
