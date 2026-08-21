import { describe, it, expect } from "vitest";
import {
  parseQuantity,
  toNutrientUnit,
  selectBand,
  resolveNutrientKey,
  nutrientByKey,
  summarizeStack,
  stackUlWarnings,
  stackRdaAdequacy,
  dietaryLimitSignalKey,
  ulWarningTitle,
  ulWarningDetail,
  ulConditionCaveat,
  ulWarningEvidence,
  rdaAdequacySignalKey,
  rdaAdequacyTitle,
  rdaAdequacyDetail,
  fmtAmount,
  elementalReading,
  doseUnitCount,
  readDoseQuantity,
  type DoseUnit,
  type StackItem,
  type StackIngredient,
} from "../dri";

// Pure tests for the supplement stack-total UL checker (issue #148): unit parsing +
// conversion (mg/mcg/IU/RAE), per-profile summation, the supplemental-vs-total UL
// distinction, age/sex band selection, and the <UL / =UL / >UL boundaries. All
// synthetic. Values assert against the committed lib/dri.json (magnesium UL 350
// supplemental, vitamin A total with 0.3 mcg RAE/IU, vitamin D 0.025 mcg/IU).

const active = (name: string, doseAmounts: (string | null)[]): StackItem => ({
  name,
  active: true,
  doseAmounts,
});

// An on-demand (`may` obligation) stack member — the conservative-direction subject.
const onDemand = (name: string, doseAmounts: (string | null)[]): StackItem => ({
  name,
  active: true,
  doseAmounts,
  optional: true,
});

describe("parseQuantity", () => {
  it("parses a plain mass amount", () => {
    expect(parseQuantity("400 mg")).toEqual({ value: 400, unit: "mg" });
    expect(parseQuantity("200 mcg")).toEqual({ value: 200, unit: "mcg" });
    expect(parseQuantity("5 g")).toEqual({ value: 5, unit: "g" });
    expect(parseQuantity("1.5 g")).toEqual({ value: 1.5, unit: "g" });
  });

  it("parses IU and is case-insensitive", () => {
    expect(parseQuantity("5000 IU")).toEqual({ value: 5000, unit: "iu" });
    expect(parseQuantity("2000 iu")).toEqual({ value: 2000, unit: "iu" });
  });

  it("normalizes µg / ug to mcg", () => {
    expect(parseQuantity("50 µg")).toEqual({ value: 50, unit: "mcg" });
    expect(parseQuantity("50 ug")).toEqual({ value: 50, unit: "mcg" });
  });

  it("takes the FIRST quantity from a combo amount", () => {
    // "Vitamin D3 + K2" style: 2000 IU (D) / 100 mcg (K2) → the leading D amount.
    expect(parseQuantity("2000 IU / 100 mcg")).toEqual({
      value: 2000,
      unit: "iu",
    });
  });

  it("returns null for non-quantitative or empty amounts", () => {
    expect(parseQuantity("1 capsule")).toBeNull();
    expect(parseQuantity("1 scoop")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
});

// EVERY SEPARATOR SHAPE, IN ONE TABLE (issue #3153).
//
// A table rather than a handful of cases, because the defect this pins is a
// PLAUSIBLE-LOOKING NUMBER. "1,000 mg" did not throw and did not return null — it
// returned a confident 0, because the old pattern could not span the comma and
// matched the "000". One happy-path example would have proved nothing about that; the
// only useful assertion is the exhaustive one, so each row states the reading and each
// refusal states that it is a refusal.
//
// `expected` is the value in the stated unit, or "unreadable" when the string carries
// a number against a unit that cannot be resolved to one reading, or "none" when there
// is no number+unit in it at all. The last two both surface as null from
// parseQuantity; readDoseQuantity is what tells them apart, and the write boundary
// needs that difference to know whether to refuse a save.
describe("parseQuantity separators (#3153)", () => {
  const cases: Array<{
    amount: string | null;
    expected: number | "unreadable" | "none";
    unit?: DoseUnit;
    why: string;
  }> = [
    // ── plain: unchanged, and here so a regression in the common case is loud ──
    { amount: "400 mg", expected: 400, unit: "mg", why: "plain integer" },
    { amount: "5000 IU", expected: 5000, unit: "iu", why: "plain integer IU" },
    { amount: "200 mcg", expected: 200, unit: "mcg", why: "plain integer mcg" },

    // ── thousands separator: THE BUG. Every one of these returned 0 before. ──
    {
      amount: "1,000 mg",
      expected: 1000,
      unit: "mg",
      why: "the niacin label in the issue; read as 0 before",
    },
    {
      amount: "5,000 IU",
      expected: 5000,
      unit: "iu",
      why: "the vitamin D label in the issue; read as 0 before",
    },
    {
      amount: "1,500 mg",
      expected: 1500,
      unit: "mg",
      why: "read as 500 before — wrong without ever looking wrong",
    },
    {
      amount: "10,000 IU",
      expected: 10000,
      unit: "iu",
      why: "two leading digits before the group",
    },
    {
      amount: "1,234,567 mcg",
      expected: 1234567,
      unit: "mcg",
      why: "more than one group",
    },

    // ── decimal point: unchanged, and these are the shipped catalog shapes ──
    { amount: "1.5 g", expected: 1.5, unit: "g", why: "one decimal place" },
    { amount: "0.5 g", expected: 0.5, unit: "g", why: "leading zero decimal" },
    {
      amount: "1.25 mg",
      expected: 1.25,
      unit: "mg",
      why: "two decimal places",
    },
    {
      amount: "0.19 mg",
      expected: 0.19,
      unit: "mg",
      why: "supplement-catalog",
    },
    { amount: "2.5mg", expected: 2.5, unit: "mg", why: "no space before unit" },
    {
      amount: "1000.500 mg",
      expected: 1000.5,
      unit: "mg",
      why: "four leading digits cannot be a thousands group, so it reads",
    },

    // ── decimal comma: REFUSED. 2,5 is 2.5 in Berlin and 25 in Boston. ──
    {
      amount: "2,5 g",
      expected: "unreadable",
      why: "the issue's 10x case: read as 5 g = 5000 mg before",
    },
    {
      amount: "1,00 mg",
      expected: "unreadable",
      why: "two digits after the comma is no grouping anyone writes",
    },
    {
      amount: "1,0000 mg",
      expected: "unreadable",
      why: "four digits after the comma is not a group either",
    },

    // ── a LEADING ZERO before the comma: REFUSED (#3444). No convention on earth
    // writes a thousands group starting with a zero, so the zero PROVES the comma is
    // a decimal — the same thing it already proved on the period side, where "0.125"
    // was refused from the start. Until #3444 these read as thousands groups and
    // returned a confident number three orders of magnitude out.
    {
      amount: "0,125 mg",
      expected: "unreadable",
      why: "digoxin's real strength; read as 125 mg — a thousandfold overdose",
    },
    {
      amount: "0,5 mg",
      expected: "unreadable",
      why: "one digit after the comma was already refused; pinned as the pair",
    },
    {
      amount: "0,500 mg",
      expected: "unreadable",
      why: "half a milligram, read as 500 mg",
    },
    {
      amount: "0,05 mg",
      expected: "unreadable",
      why: "levothyroxine 50 mcg written the European way",
    },
    {
      amount: "012,345 mg",
      expected: "unreadable",
      why: "a padded leading group is no more a thousands group than a bare 0",
    },
    {
      amount: "0.125 mg",
      expected: "unreadable",
      why: "THE SYMMETRY PARTNER — the period side has always refused this",
    },

    // ── the NAKED DECIMAL: a separator with no digits before it (#3444). ISMP names
    // this as its own error class precisely because people drop the leading zero, and
    // it lands on the same drugs. Before the scan was guarded, the match simply STARTED
    // after the separator: ".125 mg" read 125 — a thousandfold overdose from a string
    // that is missing one character. Refused rather than skipped, so the write boundary
    // declines the save and the data-quality gap names it, instead of it reading as an
    // absence nothing mentions.
    {
      amount: ".125 mg",
      expected: "unreadable",
      why: "digoxin without its leading zero; read as 125 mg before",
    },
    {
      amount: ",125 mg",
      expected: "unreadable",
      why: "the same thing with the European separator; also read as 125",
    },
    {
      amount: ".5 mg",
      expected: "unreadable",
      why: "read as 5 mg before — ten times, and the commonest naked decimal",
    },
    {
      amount: ".9mcg",
      expected: "unreadable",
      why: "no space either; the separator still cannot start a number",
    },
    {
      amount: "0.5 mg",
      expected: 0.5,
      unit: "mg",
      why: "THE CONTROL — writing the zero is what makes it readable, and must stay",
    },

    // ── period sitting where a thousands group would: REFUSED, same coin flip ──
    {
      amount: "10.000 IU",
      expected: "unreadable",
      why: "ten thousand IU on a European label, or ten; unknowable",
    },
    { amount: "1.000 mg", expected: "unreadable", why: "1000 mg, or 1 mg" },
    { amount: "2.500 mg", expected: "unreadable", why: "2500 mg, or 2.5 mg" },

    // ── both separators: the comma has already named itself, so the period reads ──
    {
      amount: "1,234.5 mg",
      expected: 1234.5,
      unit: "mg",
      why: "comma group settles which separator is which",
    },
    {
      amount: "1,000.500 mg",
      expected: 1000.5,
      unit: "mg",
      why: "same, with the otherwise-ambiguous three decimal places",
    },

    // ── no unit / unknown unit: none, not unreadable. Nothing to refuse. ──
    { amount: "1 capsule", expected: "none", why: "a count, not a quantity" },
    { amount: "2", expected: "none", why: "a bare count" },
    {
      amount: "10 ml",
      expected: "none",
      why: "a volume is not a dose unit we convert (#2856)",
    },
    { amount: "1,000 capsules", expected: "none", why: "grouped, but no unit" },
    { amount: "", expected: "none", why: "empty" },
    { amount: null, expected: "none", why: "absent" },
    {
      amount: "Proprietary blend",
      expected: "none",
      why: "no digits at all",
    },

    // ── the scan is unchanged: first unit-bearing number wins, wherever it sits ──
    {
      amount: "2000 IU / 100 mcg",
      expected: 2000,
      unit: "iu",
      why: "combo amount, leading nutrient",
    },
    {
      amount: "2 capsules (500 mg)",
      expected: 500,
      unit: "mg",
      why: "a count before the mass does not become the quantity",
    },
    {
      amount: "2 capsules (1,000 mg)",
      expected: 1000,
      unit: "mg",
      why: "both behaviours at once — the count is skipped AND the group reads",
    },
    {
      amount: "Vitamin C, 500 mg",
      expected: 500,
      unit: "mg",
      why: "a comma belonging to PROSE must not block the number after it",
    },
    {
      amount: "50 µg",
      expected: 50,
      unit: "mcg",
      why: "micro sign normalizes",
    },
    { amount: "50 ug", expected: 50, unit: "mcg", why: "ascii ug normalizes" },
  ];

  for (const c of cases) {
    it(`${JSON.stringify(c.amount)} — ${c.why}`, () => {
      const reading = readDoseQuantity(c.amount);
      if (typeof c.expected === "number") {
        expect(reading).toEqual({
          kind: "quantity",
          value: c.expected,
          unit: c.unit,
        });
        expect(parseQuantity(c.amount)).toEqual({
          value: c.expected,
          unit: c.unit,
        });
      } else {
        expect(reading.kind).toBe(c.expected);
        // Both refusals reach the totals as "nothing to add" — never a number.
        expect(parseQuantity(c.amount)).toBeNull();
      }
    });
  }
});

// The harm the issue is actually about: the number feeds the upper-limit warnings, so
// a dose that could not be read is a warning that never fires. These assert through
// stackUlWarnings rather than the parser, because that is where a person would have
// seen it — or in this case, not seen it.
describe("a grouped dose amount reaches the UL warnings (#3153)", () => {
  it("warns on niacin at 1,000 mg, which was silently zero", () => {
    const [warning] = stackUlWarnings(
      [active("Niacin", ["1,000 mg"])],
      40,
      "male"
    );
    expect(warning).toBeDefined();
    expect(warning.total).toBe(1000);
    // The same stack written without the separator has always warned; the separator
    // was the entire difference between a warning and silence.
    const [plain] = stackUlWarnings(
      [active("Niacin", ["1000 mg"])],
      40,
      "male"
    );
    expect(plain.total).toBe(warning.total);
  });

  it("counts a 5,000 IU vitamin D dose that used to count as zero", () => {
    const [grouped] = summarizeStack(
      [active("Vitamin D3", ["5,000 IU"])],
      40,
      "male"
    );
    const [plain] = summarizeStack(
      [active("Vitamin D3", ["5000 IU"])],
      40,
      "male"
    );
    expect(grouped.total).toBeGreaterThan(0);
    expect(grouped.total).toBe(plain.total);
  });

  it("contributes NOTHING for an unreadable amount, rather than 10x", () => {
    // "2,5 g" of magnesium used to read as 5 g and raise a warning at ten times the
    // dose meant. Absent is the honest reading; the write boundary is what stops a
    // NEW one being stored (intake-actions), so nothing here invents a number.
    const warnings = stackUlWarnings(
      [active("Magnesium Glycinate", ["2,5 g"])],
      40,
      "male"
    );
    expect(warnings).toEqual([]);
    const [total] = summarizeStack(
      [active("Magnesium Glycinate", ["2,5 g"])],
      40,
      "male"
    );
    expect(total).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3451 — A THOUSANDS SEPARATOR THAT IS NOT A COMMA.
//
// Same failure as #3153, reached by a different character: the scan stopped at the
// separator, restarted after it, matched "000 mg" and returned a CONFIDENT ZERO. A
// niacin dose of 1 000 mg is 28x the 35 mg adult UL, and the warning simply did not
// fire — a zero meaning "we could not read this" is indistinguishable from a zero
// meaning "none".
//
// THE FIX IS DELIBERATELY NOT UNIFORM ACROSS THE SEVEN SPELLINGS, and this file is
// where that split has to be visible, because both halves are safety claims:
//
//   * the six separators that EXIST to group thousands are READ, so the warning fires;
//   * the plain ASCII space U+0020 is REFUSED, because on a label "1 500 mg" is as
//     plausibly one 500 mg tablet as it is fifteen hundred milligrams. Reading it as a
//     group would have swapped a confident zero for a confident overdose.
//
// So the "refused" half asserts something weaker than a warning ON PURPOSE: the dose
// contributes nothing, exactly as before — but it is now `unreadable` rather than a
// quantity of 0, which is what makes the write boundary refuse the save
// (intake-actions.unreadableDoseAmount) and the row appear in the
// `dose-amount-unreadable` gap (queries/data-quality.getUnreadableDoseAmounts). The
// silence is the same; the visibility is the whole difference.
// ─────────────────────────────────────────────────────────────────────────────

// The spellings that mean "thousands group" and nothing else. Written as escapes:
// six of the seven are invisible or near-invisible in an editor.
const UNAMBIGUOUS_SEPARATORS: { sep: string; why: string }[] = [
  { sep: "\u00a0", why: "no-break space — the word-processor grouping space" },
  { sep: "\u202f", why: "narrow no-break space — the SI/ISO-80000 spelling" },
  { sep: "\u2009", why: "thin space — the same, in typesetting" },
  { sep: "\u2007", why: "figure space — digit-width, for columns of figures" },
  { sep: "\u2019", why: "right single quote — the Swiss spelling, 1\u2019000" },
  { sep: "\u0027", why: "apostrophe — Swiss, as typed on an ASCII keyboard" },
  { sep: "\u066c", why: "Arabic thousands separator" },
];

describe("a non-comma thousands separator never reads as a confident zero (#3451)", () => {
  for (const { sep, why } of UNAMBIGUOUS_SEPARATORS) {
    const amount = `1${sep}000 mg`;
    it(`U+${sep.codePointAt(0)!.toString(16).padStart(4, "0")} reads 1000 mg (${why})`, () => {
      expect(readDoseQuantity(amount)).toEqual({
        kind: "quantity",
        value: 1000,
        unit: "mg",
      });
    });

    // THE ASSERTION THE ISSUE IS ACTUALLY ABOUT. A parser test that never reaches the
    // limit check leaves the harm unpinned, so each spelling is walked all the way to
    // the warning a person would or would not have seen.
    it(`U+${sep.codePointAt(0)!.toString(16).padStart(4, "0")} niacin at 1${sep}000 mg warns against the 35 mg UL`, () => {
      const [warning] = stackUlWarnings(
        [active("Niacin", [amount])],
        40,
        "male"
      );
      expect(warning).toBeDefined();
      expect(warning.total).toBe(1000);
      // The control: the same stack with no separator at all has always warned, so a
      // fix that merely stopped returning zero (by returning some OTHER number) does
      // not pass this.
      const [plain] = stackUlWarnings(
        [active("Niacin", ["1000 mg"])],
        40,
        "male"
      );
      expect(warning.total).toBe(plain.total);
    });
  }

  // THE PLAIN SPACE, WHICH IS THE ONE THAT MUST NOT BE READ.
  it("refuses U+0020 rather than reading it as a group OR as a zero", () => {
    const reading = readDoseQuantity("1 000 mg");
    expect(reading).toEqual({ kind: "unreadable" });
    // Spelled out because BOTH wrong answers are single-token edits away, and each is
    // a different disaster: 0 is the silent one this issue was filed for, 1000 is the
    // confident-overdose one that a uniform fix would have introduced.
    expect(reading).not.toEqual({ kind: "quantity", value: 0, unit: "mg" });
    expect(reading).not.toEqual({ kind: "quantity", value: 1000, unit: "mg" });
    expect(parseQuantity("1 000 mg")).toBeNull();
  });

  it("a space-separated niacin dose is SILENT but VISIBLE, not a zero", () => {
    // Silent: nothing may be invented, so no warning and no total. Identical outcome
    // to the confident zero, which is why the assertion below it is the load-bearing
    // one.
    expect(stackUlWarnings([active("Niacin", ["1 000 mg"])], 40, "male")).toEqual(
      []
    );
    expect(summarizeStack([active("Niacin", ["1 000 mg"])], 40, "male")).toEqual(
      []
    );
    // Visible: `unreadable` is the reading the write boundary refuses and the
    // data-quality gap lists. `quantity 0` is the reading nothing anywhere can see.
    expect(readDoseQuantity("1 000 mg").kind).toBe("unreadable");
  });

  // WHY U+0020 IS REFUSED AND NOT READ, as behaviour rather than as a comment. On a
  // real label a count precedes a strength, and this codebase already parses that
  // shape (doseUnitCount, and COUNT in lib/prescription-parse.ts).
  it("never reads a count-then-strength label as a thousands group", () => {
    for (const amount of [
      "1 500 mg tablet",
      "2 500 mg tablets",
      "1 000 mg",
      "1 000 000 mg",
      // THE DECIMAL TAIL, and it is the case that decides the shape of the pattern
      // rather than a variation on the ones above. Without `(?:[.,]\d+)?` on the space
      // branch the branch fails on this string, the ordinary branch then starts after
      // the space, and "000.5 mg" reads as a confident 0.5 mg.
      "1 000.5 mg",
    ]) {
      expect(readDoseQuantity(amount)).toEqual({ kind: "unreadable" });
    }
  });

  // A NAME MAY END IN A DIGIT, and then the space before the strength is not inside a
  // number at all. These are the four commonest such names in a supplement stack; each
  // read correctly before #3451 and must still.
  it("leaves a strength that follows a digit-ending name alone", () => {
    expect(readDoseQuantity("B12 500 mcg")).toEqual({
      kind: "quantity",
      value: 500,
      unit: "mcg",
    });
    expect(readDoseQuantity("CoQ10 200 mg")).toEqual({
      kind: "quantity",
      value: 200,
      unit: "mg",
    });
    expect(readDoseQuantity("Vitamin D3 5000 IU")).toEqual({
      kind: "quantity",
      value: 5000,
      unit: "iu",
    });
    // The second group has FOUR digits, so it is not a thousands-group shape and the
    // space branch must not claim it.
    expect(readDoseQuantity("Omega 3 1000 mg")).toEqual({
      kind: "quantity",
      value: 1000,
      unit: "mg",
    });
  });

  // The grouping rule is the comma's, not a second one: a leading zero still proves
  // the separator is a decimal, and a group that is not three digits is still refused.
  it("puts the new separators through the comma's grouping rule, not a looser one", () => {
    expect(readDoseQuantity("1\u2019000\u2019000 mg")).toEqual({
      kind: "quantity",
      value: 1000000,
      unit: "mg",
    });
    // "0,125" is refused because no convention groups thousands behind a leading zero;
    // "0\u2019125" is the same string in Swiss and gets the same answer.
    expect(readDoseQuantity("0\u2019125 mg").kind).toBe("unreadable");
    expect(readDoseQuantity("1\u20190000 mg").kind).toBe("unreadable");
    // A decimal tail after a real group still reads, exactly as "1,000.500" does.
    expect(readDoseQuantity("1\u2019000.5 mg")).toEqual({
      kind: "quantity",
      value: 1000.5,
      unit: "mg",
    });
  });
});

describe("toNutrientUnit", () => {
  it("converts retinol IU to mcg RAE for vitamin A (0.3 mcg/IU)", () => {
    const vitA = nutrientByKey("vitamin_a")!;
    expect(toNutrientUnit({ value: 10000, unit: "iu" }, vitA)).toBeCloseTo(
      3000
    );
    expect(toNutrientUnit({ value: 5000, unit: "iu" }, vitA)).toBeCloseTo(1500);
  });

  it("converts vitamin D IU to mcg (0.025 mcg/IU, i.e. 40 IU = 1 mcg)", () => {
    const vitD = nutrientByKey("vitamin_d")!;
    expect(toNutrientUnit({ value: 2000, unit: "iu" }, vitD)).toBeCloseTo(50);
    expect(toNutrientUnit({ value: 10000, unit: "iu" }, vitD)).toBeCloseTo(250);
  });

  it("converts mass units into a mg-canonical nutrient", () => {
    const mag = nutrientByKey("magnesium")!; // unit mg
    expect(toNutrientUnit({ value: 400, unit: "mg" }, mag)).toBe(400);
    expect(toNutrientUnit({ value: 0.4, unit: "g" }, mag)).toBeCloseTo(400);
    expect(toNutrientUnit({ value: 500000, unit: "mcg" }, mag)).toBeCloseTo(
      500
    );
  });

  it("converts mass units into a mcg-canonical nutrient", () => {
    const sel = nutrientByKey("selenium")!; // unit mcg
    expect(toNutrientUnit({ value: 0.2, unit: "mg" }, sel)).toBeCloseTo(200);
    expect(toNutrientUnit({ value: 100, unit: "mcg" }, sel)).toBe(100);
  });

  it("returns null for an IU dose on a nutrient with no IU factor", () => {
    const mag = nutrientByKey("magnesium")!;
    expect(toNutrientUnit({ value: 100, unit: "iu" }, mag)).toBeNull();
  });
});

describe("resolveNutrientKey", () => {
  it("maps catalog supplement names to nutrient keys", () => {
    expect(resolveNutrientKey("Magnesium Glycinate")).toBe("magnesium");
    expect(resolveNutrientKey("Magnesium Citrate")).toBe("magnesium");
    expect(resolveNutrientKey("Zinc")).toBe("zinc");
    expect(resolveNutrientKey("Vitamin A")).toBe("vitamin_a");
    expect(resolveNutrientKey("Vitamin D3")).toBe("vitamin_d");
    expect(resolveNutrientKey("Vitamin D3 + K2")).toBe("vitamin_d");
    expect(resolveNutrientKey("Niacin")).toBe("niacin");
    expect(resolveNutrientKey("Folate")).toBe("folate");
  });

  it("returns null for names that map to no UL-bearing nutrient", () => {
    expect(resolveNutrientKey("Multivitamin")).toBeNull();
    expect(resolveNutrientKey("Whey Protein")).toBeNull();
    expect(resolveNutrientKey("Ashwagandha")).toBeNull();
    expect(resolveNutrientKey("Potassium")).toBeNull(); // no UL → not modeled
  });
});

// #2934 — recognition was wrong in BOTH directions, and each direction needs its own
// evidence: a real dose that contributed zero, and an excipient that contributed as
// if it were a dose. The corpus is a list of names whose answer is known, so a later
// change that fixes one direction by loosening into the other fails here.
//
// THE CORPUS IS THE LOAD-BEARING PART, not the parity test below it. A parity check
// cannot catch a name that is wrong in BOTH directions at once — both readers go
// silent together and agree perfectly — which is exactly how `Magnesium Trisilicate`
// got excused as talc and took a 2000 mg/day antacid stack quiet with it. Only a
// stated expected answer per name can see that, so every name added to the excipient
// list belongs here with its near-misses.
const RECOGNITION_CORPUS: {
  name: string;
  key: string | null;
  why: string;
}[] = [
  // Over-count: a nutrient named as an EXCIPIENT is not a dose of it.
  {
    name: "Magnesium Stearate",
    key: null,
    why: "the catalog's most common flow agent, present in trace amounts",
  },
  {
    name: "Calcium Stearate",
    key: null,
    why: "the same excipient, other mineral",
  },
  {
    name: "Zinc Stearate",
    key: null,
    why: "the same excipient, other mineral",
  },
  { name: "Magnesium Silicate", key: null, why: "an anticaking agent (talc)" },
  {
    name: "Magnesium Stearates",
    key: null,
    why: "the same excipient, pluralized on a label",
  },
  // The excipient list's own near-miss: three letters from talc, and not an excipient.
  {
    name: "Magnesium Trisilicate",
    key: "magnesium",
    why: "a licensed antacid active ingredient, not talc",
  },
  // Under-count: shelf spellings that genuinely mean the mineral.
  {
    name: "Mag Threonate",
    key: "magnesium",
    why: "front-of-bottle abbreviation",
  },
  {
    name: "Mag L-Threonate",
    key: "magnesium",
    why: "the same, spelled in full",
  },
  {
    name: "Milk of Magnesia",
    key: "magnesium",
    why: "a real magnesium product",
  },
  // Near-misses: what the careless loosening would have swept in.
  { name: "Magnolia", key: null, why: "a herb — no form word, no mineral" },
  { name: "Mag 07", key: null, why: "an abbreviation with no salt named" },
  { name: "Manganese", key: "manganese", why: "a different mineral entirely" },
  // An excipient named ALONGSIDE the real dose still doses the mineral.
  {
    name: "Magnesium Citrate (with magnesium stearate)",
    key: "magnesium",
    why: "the excipient mention is excused, the citrate dose is not",
  },
  // Unchanged by any of the above.
  { name: "Magnesium Glycinate", key: "magnesium", why: "the baseline case" },
  { name: "Vitamin D3", key: "vitamin_d", why: "another matcher, untouched" },
];

describe("nutrient recognition, in both directions (#2934)", () => {
  for (const { name, key, why } of RECOGNITION_CORPUS) {
    it(`${name} → ${key ?? "no nutrient"} (${why})`, () => {
      expect(resolveNutrientKey(name)).toBe(key);
    });
  }

  // ONE VOCABULARY, TWO READERS. The UL check is a risk number and the adequacy note
  // is a reassurance number, so recognition moves them in opposite directions — which
  // is exactly why a change that improves one can silently degrade the other. Both are
  // pinned on EVERY corpus entry: an item counts for both readers or for neither.
  it("the UL reader sees exactly the recognized names", () => {
    for (const { name, key } of RECOGNITION_CORPUS) {
      // 800 mg is above every UL a corpus entry can resolve to, so a recognized item
      // always warns and an unrecognized one can never warn.
      const warnings = stackUlWarnings([active(name, ["800 mg"])], 30, null);
      expect(warnings.map((w) => w.key)).toEqual(key ? [key] : []);
    }
  });

  it("the RDA adequacy reader sees exactly the same names", () => {
    for (const { name, key } of RECOGNITION_CORPUS) {
      // 1 mcg is below every RDA a corpus entry can resolve to, so a recognized item
      // always reports a share and an unrecognized one is never named.
      const notes = stackRdaAdequacy([active(name, ["1 mcg"])], 30, null);
      expect(notes.map((a) => a.key)).toEqual(key ? [key] : []);
    }
  });

  it("an antacid dose of magnesium trisilicate still warns", () => {
    // 500 mg x 4/day of a licensed antacid: 2000 mg against a 350 mg supplemental UL.
    // Excusing it as talc took this stack silent, which is the one direction this
    // module may never move.
    const warnings = stackUlWarnings(
      [
        active("Magnesium Trisilicate", [
          "500 mg",
          "500 mg",
          "500 mg",
          "500 mg",
        ]),
      ],
      40,
      "male"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].key).toBe("magnesium");
    expect(warnings[0].total).toBe(2000);
    expect(warnings[0].ul).toBe(350);
  });

  it("Milk of Magnesia reads like the hydroxide it is", () => {
    // Two names for one product must not diverge: without the `magnesia` form this
    // read 2400 mg where "Magnesium Hydroxide" read 1000.8 mg, 2.4x apart.
    const magnesium = nutrientByKey("magnesium")!;
    const asMilk = elementalReading("Milk of Magnesia", magnesium, 2400);
    const asChemical = elementalReading("Magnesium Hydroxide", magnesium, 2400);
    expect(asMilk).toEqual(asChemical);
    expect(asMilk.compound).toBe("magnesium hydroxide");
    // And the copy names the compound the reader can check against the bottle.
    expect(asMilk.amount).toBeCloseTo(1000.8, 1);
  });

  it("an excipient no longer inflates a real magnesium total", () => {
    // Before: 400 + 200 = 600 mg, and the evidence line named the flow agent as a
    // contributor on a safety surface.
    const warnings = stackUlWarnings(
      [
        active("Magnesium Glycinate", ["400 mg"]),
        active("Magnesium Stearate", ["200 mg"]),
      ],
      30,
      null
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].total).toBe(400);
    expect(warnings[0].contributors.map((c) => c.name)).toEqual([
      "Magnesium Glycinate",
    ]);
  });

  it("a recognized abbreviation contributes its amount, arithmetic unchanged", () => {
    // Recognition is all that changed: at/below the stated-elemental ceiling the
    // amount counts exactly as entered, and above it the #2798 compound reading
    // applies to the abbreviation the same way it applies to the full spelling.
    const [asEntered] = stackUlWarnings(
      [active("Mag Threonate", ["500 mg"])],
      30,
      null
    );
    expect(asEntered.total).toBe(500);
    expect(asEntered.contributors[0].compound).toBeUndefined();

    // Above the ceiling the compound reading applies — and legitimately takes the
    // total back UNDER the UL, so the total is read off summarizeStack rather than
    // the warning list the corrected number no longer belongs on.
    const [asCompound] = summarizeStack(
      [active("Mag Threonate", ["2 g"])],
      30,
      null
    );
    expect(asCompound.total).toBeCloseTo(166, 0); // 2000 mg × 8.3%
    expect(asCompound.contributors[0].compound).toBe("magnesium L-threonate");
    expect(
      stackUlWarnings([active("Mag Threonate", ["2 g"])], 30, null)
    ).toEqual([]);
  });
});

describe("selectBand (age/sex)", () => {
  it("selects the adult band and default age when age is unknown", () => {
    const mag = nutrientByKey("magnesium")!;
    expect(selectBand(mag, null, null)?.ul).toBe(350);
    expect(selectBand(mag, 30, null)?.ul).toBe(350);
  });

  it("selects a pediatric band by age", () => {
    const mag = nutrientByKey("magnesium")!;
    expect(selectBand(mag, 2, null)?.ul).toBe(65); // 1–4 band
    expect(selectBand(mag, 6, null)?.ul).toBe(110); // 4–9 band
  });

  it("returns null below the youngest band (infant)", () => {
    const mag = nutrientByKey("magnesium")!;
    expect(selectBand(mag, 0, null)).toBeNull();
  });

  it("prefers the sex-specific band for RDA (iron 19–50)", () => {
    const iron = nutrientByKey("iron")!;
    expect(selectBand(iron, 30, "female")?.rda).toBe(18);
    expect(selectBand(iron, 30, "male")?.rda).toBe(8);
    // UL is sex-neutral either way.
    expect(selectBand(iron, 30, "female")?.ul).toBe(45);
  });

  it("half-open bands: max_age is exclusive", () => {
    const cal = nutrientByKey("calcium")!;
    // 19–51 band UL 2500; the 51+ band steps down to 2000.
    expect(selectBand(cal, 50, null)?.ul).toBe(2500);
    expect(selectBand(cal, 51, null)?.ul).toBe(2000);
  });
});

describe("summarizeStack", () => {
  it("sums two products of the same nutrient into one stack total", () => {
    const totals = summarizeStack(
      [
        active("Magnesium Glycinate", ["400 mg"]),
        active("Magnesium Citrate", ["200 mg"]),
      ],
      30,
      "male"
    );
    const mag = totals.find((t) => t.key === "magnesium")!;
    expect(mag.total).toBe(600);
    expect(mag.ul).toBe(350);
    expect(mag.basis).toBe("supplemental");
    expect(mag.contributors.map((c) => c.name)).toEqual([
      "Magnesium Glycinate",
      "Magnesium Citrate",
    ]);
  });

  it("sums a split dose (multiple dose rows) within one item", () => {
    const totals = summarizeStack(
      [active("Magnesium Glycinate", ["200 mg", "200 mg"])],
      30,
      null
    );
    expect(totals.find((t) => t.key === "magnesium")!.total).toBe(400);
  });

  it("excludes inactive items and non-quantitative doses", () => {
    const totals = summarizeStack(
      [
        { name: "Magnesium Glycinate", active: false, doseAmounts: ["400 mg"] },
        active("Multivitamin", ["1 capsule"]),
      ],
      30,
      null
    );
    expect(totals).toEqual([]);
  });
});

describe("stackUlWarnings (boundaries + basis)", () => {
  it("does NOT warn when the total equals the UL", () => {
    const w = stackUlWarnings(
      [active("Magnesium Glycinate", ["350 mg"])],
      30,
      "male"
    );
    expect(w).toEqual([]);
  });

  it("does NOT warn below the UL", () => {
    const w = stackUlWarnings(
      [active("Magnesium Glycinate", ["349 mg"])],
      30,
      "male"
    );
    expect(w).toEqual([]);
  });

  it("warns strictly above the UL", () => {
    const w = stackUlWarnings(
      [active("Magnesium Glycinate", ["351 mg"])],
      30,
      "male"
    );
    expect(w).toHaveLength(1);
    expect(w[0].key).toBe("magnesium");
    expect(w[0].ul).toBe(350);
    expect(w[0].total).toBe(351);
  });

  it("respects the child UL band (a child over the toddler UL)", () => {
    // 300 mg supplemental magnesium is under the adult 350 UL but over the
    // 1–4y UL of 65 — a child stack must flag against the child band.
    expect(
      stackUlWarnings([active("Magnesium Glycinate", ["300 mg"])], 2, null)
    ).toHaveLength(1);
    expect(
      stackUlWarnings([active("Magnesium Glycinate", ["300 mg"])], 30, null)
    ).toEqual([]);
  });

  it("flags a total-basis nutrient from supplements alone (vitamin A)", () => {
    // 10000 IU retinol = 3000 mcg RAE = at the UL; 20000 IU = 6000 > 3000.
    const w = stackUlWarnings(
      [active("Vitamin A", ["20000 IU"])],
      30,
      "female"
    );
    expect(w).toHaveLength(1);
    expect(w[0].key).toBe("vitamin_a");
    expect(w[0].basis).toBe("total");
    expect(w[0].total).toBeCloseTo(6000);
  });
});

describe("stackRdaAdequacy (issue #578 — the RDA inverse)", () => {
  it("reports a nutrient the stack supplements BELOW its RDA, with the share", () => {
    // Adult male magnesium RDA is 420 mg; 200 mg supplemental → ~48% of the RDA.
    const a = stackRdaAdequacy(
      [active("Magnesium Glycinate", ["200 mg"])],
      30,
      "male"
    );
    expect(a).toHaveLength(1);
    expect(a[0].key).toBe("magnesium");
    expect(a[0].rda).toBe(420);
    expect(a[0].total).toBe(200);
    expect(a[0].sharePct).toBe(48);
  });

  it("does NOT report a nutrient at/above its RDA (the stack already meets it)", () => {
    expect(
      stackRdaAdequacy([active("Magnesium Glycinate", ["420 mg"])], 30, "male")
    ).toEqual([]);
    expect(
      stackRdaAdequacy([active("Magnesium Glycinate", ["500 mg"])], 30, "male")
    ).toEqual([]);
  });

  it("does NOT report a nutrient the stack isn't supplementing", () => {
    // Nothing in the stack contributes iron → no iron adequacy row (we can't see food).
    const a = stackRdaAdequacy(
      [active("Magnesium Glycinate", ["200 mg"])],
      30,
      "male"
    );
    expect(a.some((x) => x.key === "iron")).toBe(false);
  });

  it("skips a nutrient with no RDA in the band (boron)", () => {
    // Boron has a UL but no RDA anywhere → never an adequacy row even if supplemented.
    const a = stackRdaAdequacy([active("Boron", ["1 mg"])], 30, "male");
    expect(a).toEqual([]);
  });

  it("wording says 'supplements provide X% of the RDA', never 'deficient'", () => {
    const a = stackRdaAdequacy(
      [active("Magnesium Glycinate", ["200 mg"])],
      30,
      "male"
    )[0];
    expect(rdaAdequacySignalKey("magnesium")).toBe("rda-adequacy:magnesium");
    expect(rdaAdequacyTitle(a)).toContain("48% of the RDA");
    const detail = rdaAdequacyDetail(a);
    expect(detail.toLowerCase()).toContain("supplements alone provide");
    expect(detail.toLowerCase()).not.toContain("deficien");
  });
});

describe("the conservative-direction rule for obligation (#1505)", () => {
  // One obligation, two aggregates, opposite treatments — each erring toward caution.
  // The seeded shape both browser specs use: a committed 400 mg + an on-demand 200 mg.
  const stack = [
    active("Magnesium Glycinate", ["400 mg"]),
    onDemand("Magnesium Citrate", ["200 mg"]),
  ];

  it("summarizeStack reports the on-demand part WITHOUT subtracting it", () => {
    // The split is carried, not applied: total stays whole so each consumer can
    // choose its own direction. A summation that pre-subtracted would force one.
    const t = summarizeStack(stack, 30, "male").find(
      (x) => x.key === "magnesium"
    )!;
    expect(t.total).toBe(600);
    expect(t.optionalTotal).toBe(200);
    expect(
      t.contributors.find((c) => c.name === "Magnesium Citrate")?.optional
    ).toBe(true);
    expect(
      t.contributors.find((c) => c.name === "Magnesium Glycinate")?.optional
    ).toBeUndefined();
  });

  it("RISK: the UL total counts an on-demand item at FULL weight and says so", () => {
    const w = stackUlWarnings(stack, 30, "male")[0];
    // 600, not 400. Obligation is a wish about pushing, not a fact about intake.
    expect(w.total).toBe(600);
    expect(w.includesOptional).toBe(true);
    expect(ulWarningDetail(w)).toContain("600 mg");
    expect(ulWarningDetail(w)).toContain("including as-needed items");
  });

  it("RISK: the disclosure appears only when an on-demand item actually contributed", () => {
    const w = stackUlWarnings(
      [active("Magnesium Glycinate", ["600 mg"])],
      30,
      "male"
    )[0];
    expect(w.includesOptional).toBe(false);
    expect(ulWarningDetail(w)).not.toContain("as-needed");
  });

  it("RISK: an on-demand item can raise a stack OVER the UL on its own", () => {
    // 300 committed is under the 350 UL; +100 on-demand crosses it. Dropping the
    // on-demand amount would silence this warning entirely — the regression that
    // made contributesToDailyLimit obligation-blind.
    const w = stackUlWarnings(
      [
        active("Magnesium Glycinate", ["300 mg"]),
        onDemand("Magnesium Citrate", ["100 mg"]),
      ],
      30,
      "male"
    );
    expect(w).toHaveLength(1);
    expect(w[0].total).toBe(400);
  });

  it("REASSURANCE: the RDA share counts COMMITTED intake only, and discloses the rest", () => {
    const a = stackRdaAdequacy(stack, 30, "male");
    expect(a).toHaveLength(1);
    // Adult male magnesium RDA 420. Committed 400 → 95%, not 600/420 (which would
    // not even be a shortfall). Obligation may never inflate a reassurance figure.
    expect(a[0].total).toBe(400);
    expect(a[0].optionalTotal).toBe(200);
    expect(a[0].sharePct).toBe(95);
    const detail = rdaAdequacyDetail(a[0]);
    expect(detail).toContain("400 mg");
    expect(detail).toContain("A further 200 mg");
    expect(detail).toContain("aren't counted toward this share");
  });

  it("REASSURANCE: no aside when nothing is on demand", () => {
    const a = stackRdaAdequacy(
      [active("Magnesium Glycinate", ["200 mg"])],
      30,
      "male"
    )[0];
    expect(a.optionalTotal).toBe(0);
    expect(rdaAdequacyDetail(a)).not.toContain("as-needed");
  });

  it("REASSURANCE: a nutrient supplemented ONLY on demand still appears", () => {
    // Excluding an amount from the share must never delete the row: going quiet
    // about a nutrient the user supplements is the worst outcome for a demoted item.
    const a = stackRdaAdequacy(
      [onDemand("Magnesium Citrate", ["200 mg"])],
      30,
      "male"
    );
    expect(a).toHaveLength(1);
    expect(a[0].total).toBe(0);
    expect(a[0].sharePct).toBe(0);
    expect(a[0].optionalTotal).toBe(200);
    expect(rdaAdequacyDetail(a[0])).toContain("A further 200 mg");
  });

  it("REASSURANCE: committed intake at/above the RDA is still not reported", () => {
    // The on-demand extra cannot resurrect a row the committed total already met…
    expect(
      stackRdaAdequacy(
        [
          active("Magnesium Glycinate", ["420 mg"]),
          onDemand("Magnesium Citrate", ["200 mg"]),
        ],
        30,
        "male"
      )
    ).toEqual([]);
    // …nor can it satisfy one the committed total misses.
    const a = stackRdaAdequacy(
      [
        active("Magnesium Glycinate", ["100 mg"]),
        onDemand("Magnesium Citrate", ["400 mg"]),
      ],
      30,
      "male"
    );
    expect(a).toHaveLength(1);
    expect(a[0].sharePct).toBe(24);
  });
});

describe("warning copy + keys", () => {
  const mag = stackUlWarnings(
    [
      active("Magnesium Glycinate", ["400 mg"]),
      active("Magnesium Citrate", ["200 mg"]),
    ],
    30,
    "male"
  )[0];
  const vitA = stackUlWarnings(
    [active("Vitamin A", ["20000 IU"])],
    30,
    null
  )[0];

  it("builds a stable per-nutrient dedupe key", () => {
    expect(dietaryLimitSignalKey("magnesium")).toBe("dietary-limit:magnesium");
  });

  it("titles the finding by nutrient", () => {
    expect(ulWarningTitle(mag)).toBe("Magnesium above the upper limit");
  });

  it("wording distinguishes supplemental vs total basis", () => {
    const magDetail = ulWarningDetail(mag);
    expect(magDetail).toContain("supplemental Magnesium");
    expect(magDetail).toContain("350 mg");
    expect(magDetail).toContain("600 mg");
    expect(magDetail).toContain("with your clinician");

    const vitADetail = ulWarningDetail(vitA);
    expect(vitADetail).toContain("total intake");
    expect(vitADetail).toContain("food and drink add still more");
  });

  it("annotates the UL line for a condition that lowers the ceiling (#657)", () => {
    // CKD lowers the safe magnesium ceiling — the population UL bands only on age/sex,
    // so the line carries a caveat.
    const caveat = ulConditionCaveat("magnesium", ["chronic kidney disease"]);
    expect(caveat).not.toBeNull();
    expect(caveat).toContain("chronic kidney disease");
    expect(caveat).toContain("magnesium");
    expect(caveat).toContain("with your clinician");

    // Appended to the detail when present, absent otherwise.
    expect(ulWarningDetail(mag, caveat)).toContain("may not apply to you");
    expect(ulWarningDetail(mag)).not.toContain("may not apply to you");
    // No matching condition → no caveat.
    expect(ulConditionCaveat("magnesium", ["asthma"])).toBeNull();
  });

  it("evidence lists the contributing products, largest first", () => {
    expect(ulWarningEvidence(mag)).toBe(
      "Magnesium Glycinate 400 mg + Magnesium Citrate 200 mg"
    );
  });

  it("fmtAmount keeps whole numbers whole and rounds to one decimal", () => {
    expect(fmtAmount(600)).toBe("600");
    expect(fmtAmount(349.5)).toBe("349.5");
    expect(fmtAmount(50.04)).toBe("50");
  });
});

// Compound mass vs elemental mass (issue #2798). The reported defect: "Magnesium
// L-Threonate 2 g" was summed as 2000 mg of magnesium and flagged against the 350 mg
// UL — about fourteen times the magnesium actually in it.
//
// These tests are written around the ONE property that makes the fix safe to ship: the
// reinterpretation is one-directional. It may only ever fire on an amount too large to
// be a labeled elemental dose, so it can lower a total that was wrong and can never
// silence a warning that fires today. The "unchanged" cases below are therefore not
// filler — each one is a way the fix could have under-warned.
describe("compound vs elemental mass (#2798)", () => {
  const magnesium = nutrientByKey("magnesium")!;

  it("reads a gram-scale compound entry as the compound's weight", () => {
    const warnings = stackUlWarnings(
      [active("Magnesium L-Threonate", ["2 g"])],
      40,
      "male"
    );
    // 2000 mg of the compound is ~166 mg of magnesium — under the 350 mg UL, so the
    // over-limit warning that used to fire here is simply wrong and must be gone.
    expect(warnings).toEqual([]);

    const [total] = summarizeStack(
      [active("Magnesium L-Threonate", ["2 g"])],
      40,
      "male"
    );
    expect(total.total).toBeCloseTo(166, 0);
    expect(total.contributors[0].compound).toBe("magnesium L-threonate");
  });

  it("reads the same product labeled in milligrams the same way", () => {
    // The front of a Magtein bottle says "2,000 mg". A fix keyed on the unit being
    // grams would miss this and leave the identical product over-warning.
    const [total] = summarizeStack(
      [active("Magnesium L-Threonate", ["2000 mg"])],
      40,
      "male"
    );
    expect(total.total).toBeCloseTo(166, 0);
  });

  it("errs upward: the fraction is stoichiometric, above what the label implies", () => {
    // A Magtein label puts 2 g at 144 mg of magnesium. The stoichiometric 8.3% puts it
    // at ~166. On a risk number the higher estimate is the right one to carry.
    const [total] = summarizeStack(
      [active("Magnesium L-Threonate", ["2 g"])],
      40,
      "male"
    );
    expect(total.total).toBeGreaterThan(144);
  });

  it("leaves the baseline elemental stack untouched", () => {
    // Glycinate/citrate labels state the elemental amount, and both of these sit far
    // below the ceiling. If this ever stops reading 600 the fix has started
    // double-discounting labels that were already elemental.
    const [warning] = stackUlWarnings(
      [
        active("Magnesium Glycinate", ["400 mg"]),
        active("Magnesium Citrate", ["200 mg"]),
      ],
      40,
      "male"
    );
    expect(warning.total).toBe(600);
    expect(warning.contributors.every((c) => c.compound == null)).toBe(true);
  });

  it("never converts an amount that could be a real elemental label", () => {
    // A genuine 600 mg elemental entry on a compound-named item stays 600 and stays
    // over the UL. This is the under-warn case the ceiling exists to prevent.
    const [warning] = stackUlWarnings(
      [active("Magnesium Glycinate", ["600 mg"])],
      40,
      "male"
    );
    expect(warning.total).toBe(600);
    expect(warning.ul).toBe(350);
  });

  it("leaves a large amount alone when no compound form is named", () => {
    // "Magnesium 2 g" states no form, so there is nothing to convert and the app
    // keeps warning on what it was told.
    const [warning] = stackUlWarnings(
      [active("Magnesium", ["2 g"])],
      40,
      "male"
    );
    expect(warning.total).toBe(2000);
  });

  it("never applies one nutrient's form factor to another nutrient", () => {
    // "Zinc Citrate" matches a citrate pattern, but citrate is registered against
    // magnesium only — a cross-nutrient factor would be a silent dosing error.
    const [total] = summarizeStack(
      [active("Zinc Citrate", ["2000 mg"])],
      40,
      "male"
    );
    expect(total.key).toBe("zinc");
    expect(total.total).toBe(2000);
    expect(total.contributors[0].compound).toBeUndefined();
  });

  it("elementalReading is inert at and below the ceiling, active above it", () => {
    expect(elementalReading("Magnesium Glycinate", magnesium, 1500)).toEqual({
      amount: 1500,
      compound: null,
    });
    const above = elementalReading("Magnesium Glycinate", magnesium, 1501);
    expect(above.compound).toBe("magnesium glycinate");
    expect(above.amount).toBeCloseTo(1501 * 0.141, 3);
    // A nutrient with no ceiling entry is never reinterpreted.
    const zinc = nutrientByKey("zinc")!;
    expect(elementalReading("Zinc Citrate", zinc, 99999).compound).toBeNull();
  });

  it("says which entry was read as a compound, and marks the line elemental", () => {
    const [warning] = stackUlWarnings(
      [
        active("Magnesium Oxide", ["4 g"]),
        active("Magnesium Glycinate", ["200 mg"]),
      ],
      40,
      "male"
    );
    // 4 g of the oxide is ~2412 mg of magnesium, plus 200 elemental — still over.
    expect(warning.total).toBeCloseTo(2612, 0);
    const detail = ulWarningDetail(warning);
    expect(detail).toContain("magnesium oxide");
    expect(detail).toContain("compound's total weight");
    expect(ulWarningEvidence(warning)).toContain(
      "Magnesium Oxide 2412 mg elemental"
    );
    // The untouched item's line stays a plain amount.
    expect(ulWarningEvidence(warning)).toMatch(
      /\+ Magnesium Glycinate 200 mg$/
    );
    // Nothing converted → nothing said.
    const [plain] = stackUlWarnings(
      [active("Magnesium Glycinate", ["400 mg"])],
      40,
      "male"
    );
    expect(ulWarningDetail(plain)).not.toContain("compound's total weight");
  });
});

// The adversarial-review refutations (#2798, PR #2929 review). Each case below is a
// reproduction that PASSED on main, FAILED on the first cut of this fix, and is pinned
// here so it cannot come back. They are the attack, not the feature.
describe("compound vs elemental mass — refutations (#2798)", () => {
  const magnesium = nutrientByKey("magnesium")!;
  const ul = (items: StackItem[]) => stackUlWarnings(items, 40, "male");

  describe("a blend must be read at the MOST concentrated form it names", () => {
    // The refutation: forms were matched with `find`, i.e. declaration order, and
    // oxide is both the last declared and by far the largest fraction (60.3%). Any
    // blend naming oxide plus an earlier form was read at the SMALLER fraction and
    // went silent — the same 2 g read as the oxide the label also names is 1206 mg,
    // 3.4x the UL. Oxide-heavy magnesium complexes at gram scale are ordinary
    // products, so this was not a corner.
    it("keeps warning on an oxide/citrate/malate complex", () => {
      const [warning] = ul([
        active("Magnesium Complex (Oxide, Citrate, Malate)", ["2 g"]),
      ]);
      expect(warning).toBeDefined();
      expect(warning.total).toBeCloseTo(1206, 0);
      expect(warning.total).toBeGreaterThan(warning.ul);
      expect(warning.contributors[0].compound).toBe("magnesium oxide");
    });

    it("keeps warning on a glycinate + oxide blend", () => {
      const [warning] = ul([
        active("Magnesium Glycinate + Oxide blend", ["2 g"]),
      ]);
      expect(warning).toBeDefined();
      // Read at oxide (60.3%), not at glycinate's 14.1% — 282 mg would be silent.
      expect(warning.total).toBeCloseTo(1206, 0);
    });

    it("keeps warning on a 50/50 oxide/citrate blend at a total that is over either way", () => {
      const [warning] = ul([active("Magnesium Oxide Citrate", ["2 g"])]);
      expect(warning).toBeDefined();
      expect(warning.total).toBeGreaterThan(350);
    });

    it("picks the maximum fraction whatever order the names appear in", () => {
      // Declaration order must not leak into the answer from either direction.
      for (const name of [
        "Magnesium Oxide and Citrate",
        "Magnesium Citrate and Oxide",
      ]) {
        expect(elementalReading(name, magnesium, 2000).amount).toBeCloseTo(
          1206,
          0
        );
      }
    });

    it("still reads a single-form entry at its own fraction", () => {
      // The max rule must not inflate an item that names exactly one form.
      const reading = elementalReading(
        "Magnesium L-Threonate",
        magnesium,
        2000
      );
      expect(reading.amount).toBeCloseTo(166, 0);
      expect(reading.compound).toBe("magnesium L-threonate");
    });
  });

  describe("the ceiling protects a DAILY TOTAL, not one dose row", () => {
    it("converts Magtein taken as the standard 1.5 g + 0.5 g split", () => {
      // The refutation: the ceiling was tested inside the per-dose loop, so neither
      // row cleared it and the item kept reading 2000 mg of magnesium. The P1 was
      // fixed only for the single-row shape.
      const [total] = summarizeStack(
        [active("Magnesium L-Threonate", ["1.5 g", "0.5 g"])],
        40,
        "male"
      );
      expect(total.total).toBeCloseTo(166, 0);
      expect(ul([active("Magnesium L-Threonate", ["1.5 g", "0.5 g"])])).toEqual(
        []
      );
    });

    it("converts a three-way split of the same product", () => {
      const [total] = summarizeStack(
        [active("Magnesium L-Threonate", ["667 mg", "667 mg", "666 mg"])],
        40,
        "male"
      );
      expect(total.total).toBeCloseTo(166, 0);
    });

    it("does not let split rows push an ELEMENTAL entry over the ceiling", () => {
      // The mirror risk of summing first: two honest 400 mg elemental doses total
      // 800 mg, still under the ceiling, and must stay counted as entered.
      const [warning] = ul([
        active("Magnesium Glycinate", ["400 mg", "400 mg"]),
      ]);
      expect(warning.total).toBe(800);
      expect(warning.contributors[0].compound).toBeUndefined();
    });

    it("leaves the baseline two-product stack byte-identical", () => {
      // Still the load-bearing regression: separate ITEMS sum into the nutrient
      // total without either one being re-read.
      const [warning] = ul([
        active("Magnesium Glycinate", ["400 mg"]),
        active("Magnesium Citrate", ["200 mg"]),
      ]);
      expect(warning.total).toBe(600);
      expect(warning.contributors.every((c) => c.compound == null)).toBe(true);
    });
  });

  describe("the #657 condition caveat survives a blend", () => {
    it("still has a warning to attach the CKD caveat to", () => {
      // The caveat only exists ON a UL warning, so silencing the warning silences
      // the caveat — and silencing it for a CKD profile means going quiet on the
      // strength of a population UL the app itself says may not apply to them.
      const [warning] = ul([
        active("Magnesium Complex (Oxide, Citrate)", ["2 g"]),
      ]);
      expect(warning).toBeDefined();
      const caveat = ulConditionCaveat("magnesium", ["chronic kidney disease"]);
      expect(caveat).not.toBeNull();
      expect(ulWarningDetail(warning, caveat)).toContain(
        "may not apply to you"
      );
    });
  });

  describe("incidental name matches", () => {
    it("reads Magnesium Hydroxide as hydroxide, not as oxide", () => {
      // "hydroxide" contains "oxide". Taking 60.3% was cautious in direction but the
      // copy then named a product the user never entered.
      const reading = elementalReading("Magnesium Hydroxide", magnesium, 2000);
      expect(reading.compound).toBe("magnesium hydroxide");
      expect(reading.amount).toBeCloseTo(834, 0);
      // And it is still over the UL, so nothing went quiet in the correction.
      const [warning] = ul([active("Magnesium Hydroxide", ["2 g"])]);
      expect(warning.total).toBeGreaterThan(warning.ul);
      expect(ulWarningDetail(warning)).toContain("magnesium hydroxide");
      expect(ulWarningDetail(warning)).not.toContain("for magnesium oxide");
    });

    it("still reads a plain oxide entry as oxide", () => {
      expect(
        elementalReading("Magnesium Oxide", magnesium, 2000).compound
      ).toBe("magnesium oxide");
    });
  });
});

// ---- Label composition (issue #2856) --------------------------------------------
//
// A blend is one row whose NAME resolves to at most one nutrient (usually none), so
// before ingredient rows existed an "Eye Health+ · 1 cap" contributed nothing to any
// stack total even with its zinc and copper written down in the notes. These assert
// the widening: the SAME NAME_MATCHERS, applied per ingredient.

// A blend: a name the matchers know nothing about, dosed in capsules, with a label.
const blend = (
  name: string,
  doseAmounts: (string | null)[],
  ingredients: StackIngredient[]
): StackItem => ({ name, active: true, doseAmounts, ingredients });

// The adult-male UL view these cases score against (mirrors the helper above).
const compositionUl = (items: StackItem[]) =>
  stackUlWarnings(items, 40, "male");

describe("doseUnitCount (#2856)", () => {
  it("reads a stated count of label units", () => {
    expect(doseUnitCount("1 capsule")).toBe(1);
    expect(doseUnitCount("2 capsules")).toBe(2);
    expect(doseUnitCount("2 softgels")).toBe(2);
    expect(doseUnitCount("1 scoop")).toBe(1);
    expect(doseUnitCount("2 SCOOPS")).toBe(2);
    // A bare number is a count; there is nothing else it could be.
    expect(doseUnitCount("2")).toBe(2);
  });

  it("finds the count beside a strength, whichever order it was written", () => {
    // Review of #2856: refusing to look past a mass anywhere in the string turned a
    // two-capsule dose into one and DROPPED a real 50 mg zinc exceedance.
    expect(doseUnitCount("2 capsules (500 mg)")).toBe(2);
    expect(doseUnitCount("500 mg (2 capsules)")).toBe(2);
  });

  it("reads a mass or IU strength as ONE serving, never as a count", () => {
    // Reading "400 mg" as four hundred capsules would multiply every ingredient by
    // four hundred on the app's most safety-critical number.
    expect(doseUnitCount("400 mg")).toBe(1);
    expect(doseUnitCount("5000 IU")).toBe(1);
    expect(doseUnitCount("2 g")).toBe(1);
    // How many 12 g scoops "24 g" is depends on a scoop size the app does not have;
    // someone whose powder is really two scoops writes "2 scoops".
    expect(doseUnitCount("24 g")).toBe(1);
  });

  it("reads a VOLUME as one serving, not as that many units", () => {
    // Review of #2856: a children's liquid multivitamin dosed "10 ml" read as ten
    // servings and raised two over-limit warnings at ten times the truth, on a child.
    expect(doseUnitCount("10 ml")).toBe(1);
    expect(doseUnitCount("30 drops")).toBe(1);
    expect(doseUnitCount("1 tsp")).toBe(1);
  });

  it("never turns a fraction into a multiple", () => {
    // The "2" of "1/2 tablet" is half a tablet, not two of them.
    expect(doseUnitCount("1/2 tablet")).toBe(1);
  });

  it("treats an absent or wordless amount as one serving", () => {
    expect(doseUnitCount(null)).toBe(1);
    expect(doseUnitCount("")).toBe(1);
    expect(doseUnitCount("one capsule")).toBe(1);
  });
});

describe("composition stacking (#2856)", () => {
  it("stacks a blend's zinc against a standalone zinc", () => {
    // THE case from the issue. Standalone zinc 30 mg is under the 40 mg adult UL and
    // silent on its own; the blend's 11 mg is invisible to a name-only reading. Taken
    // together they are over, and only composition can see it.
    const standalone = active("Zinc", ["30 mg"]);
    const eyeBlend = blend(
      "Eye Health+",
      ["1 cap"],
      [
        { name: "Lutein", amount: 10, unit: "mg" },
        { name: "Zinc", amount: 11, unit: "mg" },
        { name: "Copper", amount: 2, unit: "mg" },
      ]
    );

    expect(compositionUl([standalone])).toEqual([]);
    expect(compositionUl([eyeBlend])).toEqual([]);

    const [warning] = compositionUl([standalone, eyeBlend]);
    expect(warning.key).toBe("zinc");
    expect(warning.total).toBeCloseTo(41, 5);
    expect(warning.ul).toBe(40);
    // The evidence line NAMES the ingredient, so the 11 mg is checkable against the
    // bottle instead of appearing from a product whose name mentions no mineral.
    expect(ulWarningEvidence(warning)).toContain("Eye Health+ (Zinc) 11 mg");
  });

  it("counts a blend dosed with a strength beside the count", () => {
    // The dropped-warning case in full: 2 x 25 mg zinc is 50 mg against a 40 mg UL,
    // and the whole string has to be read to see it.
    const twoCaps = blend(
      "Eye Health+",
      ["2 capsules (500 mg)"],
      [{ name: "Zinc", amount: 25, unit: "mg" }]
    );
    const [warning] = compositionUl([twoCaps]);
    expect(warning.total).toBeCloseTo(50, 5);
  });

  it("does not multiply a liquid dose by its millilitres", () => {
    // A child's liquid multivitamin: iron 10 mg per 10 ml serving, not per ml.
    const liquid = blend(
      "Kids Multi Liquid",
      ["10 ml"],
      [{ name: "Iron", amount: 10, unit: "mg" }]
    );
    const totals = summarizeStack([liquid], 5, "female");
    expect(totals.find((t) => t.key === "iron")?.total).toBeCloseTo(10, 5);
  });

  it("multiplies ingredient amounts by the label units taken that day", () => {
    // Ingredient amounts are per SINGLE dose unit; two softgels a day is twice each.
    const twiceDaily = blend(
      "PreserVision AREDS 2",
      ["1 softgel", "1 softgel"],
      [{ name: "Zinc", amount: 40, unit: "mg" }]
    );
    const [warning] = compositionUl([twiceDaily]);
    expect(warning.total).toBeCloseTo(80, 5);
  });

  it("converts an ingredient's IU through the nutrient, like a dose amount", () => {
    const d3 = blend(
      "Immune Blend",
      ["1 capsule"],
      [{ name: "Vitamin D3", amount: 5000, unit: "iu" }]
    );
    const totals = summarizeStack([d3], 30, "male");
    const vitD = totals.find((t) => t.key === "vitamin_d");
    // 5000 IU x 0.025 mcg/IU = 125 mcg.
    expect(vitD?.total).toBeCloseTo(125, 5);
  });

  it("takes the LARGER of the name and composition readings, never their sum", () => {
    // A blend states the same substance twice — its own name dosed by the dose row,
    // and an ingredient row saying the same thing. Summing would silently double it.
    const both = {
      name: "Zinc",
      active: true,
      doseAmounts: ["30 mg"],
      ingredients: [{ name: "Zinc", amount: 30, unit: "mg" as const }],
    };
    const totals = summarizeStack([both], 30, "male");
    expect(totals.find((t) => t.key === "zinc")?.total).toBeCloseTo(30, 5);
  });

  it("widens only: a smaller ingredient row cannot talk the name's dose down", () => {
    const mistyped = {
      name: "Zinc",
      active: true,
      doseAmounts: ["50 mg"],
      ingredients: [{ name: "Zinc", amount: 5, unit: "mg" as const }],
    };
    const [warning] = compositionUl([mistyped]);
    expect(warning.total).toBeCloseTo(50, 5);
  });

  it("sums two ingredient rows naming the same element", () => {
    const twoForms = blend(
      "Zinc Complex",
      ["1 capsule"],
      [
        { name: "Zinc picolinate", amount: 25, unit: "mg" },
        { name: "Zinc gluconate", amount: 25, unit: "mg" },
      ]
    );
    const [warning] = compositionUl([twoForms]);
    expect(warning.total).toBeCloseTo(50, 5);
  });

  it("ignores an ingredient row with no parseable amount", () => {
    // "Proprietary blend" names a substance for the safety belts but states no
    // number; it must never become a fabricated zero or a fabricated anything else.
    const vague = blend(
      "Mood Support",
      ["1 capsule"],
      [{ name: "Zinc", amount: null, unit: null }]
    );
    expect(summarizeStack([vague], 30, "male")).toEqual([]);
  });

  it("leaves an item with no ingredient rows exactly as it was", () => {
    const before = summarizeStack([active("Zinc", ["30 mg"])], 30, "male");
    const after = summarizeStack(
      [{ ...active("Zinc", ["30 mg"]), ingredients: [] }],
      30,
      "male"
    );
    expect(after).toEqual(before);
  });
});
