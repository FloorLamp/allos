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
  type StackItem,
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
