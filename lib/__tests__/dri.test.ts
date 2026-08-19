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
const compositionUl = (items: StackItem[]) => stackUlWarnings(items, 40, "male");

describe("doseUnitCount (#2856)", () => {
  it("reads a leading count as label units", () => {
    expect(doseUnitCount("1 capsule")).toBe(1);
    expect(doseUnitCount("2 capsules")).toBe(2);
    expect(doseUnitCount("2 softgels")).toBe(2);
    expect(doseUnitCount("1 scoop")).toBe(1);
  });

  it("reads a mass or IU strength as ONE unit, never as a count", () => {
    // The failure this guards: "400 mg" read as four hundred capsules would multiply
    // every ingredient by four hundred on the app's most safety-critical number.
    expect(doseUnitCount("400 mg")).toBe(1);
    expect(doseUnitCount("5000 IU")).toBe(1);
    expect(doseUnitCount("2 g")).toBe(1);
  });

  it("treats an absent or wordless amount as one unit", () => {
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
    const eyeBlend = blend("Eye Health+", ["1 cap"], [
      { name: "Lutein", amount: 10, unit: "mg" },
      { name: "Zinc", amount: 11, unit: "mg" },
      { name: "Copper", amount: 2, unit: "mg" },
    ]);

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
    const d3 = blend("Immune Blend", ["1 capsule"], [
      { name: "Vitamin D3", amount: 5000, unit: "iu" },
    ]);
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
    const twoForms = blend("Zinc Complex", ["1 capsule"], [
      { name: "Zinc picolinate", amount: 25, unit: "mg" },
      { name: "Zinc gluconate", amount: 25, unit: "mg" },
    ]);
    const [warning] = compositionUl([twoForms]);
    expect(warning.total).toBeCloseTo(50, 5);
  });

  it("ignores an ingredient row with no parseable amount", () => {
    // "Proprietary blend" names a substance for the safety belts but states no
    // number; it must never become a fabricated zero or a fabricated anything else.
    const vague = blend("Mood Support", ["1 capsule"], [
      { name: "Zinc", amount: null, unit: null },
    ]);
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
