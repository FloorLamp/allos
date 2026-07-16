import { describe, it, expect } from "vitest";
import { matchFoodInteractions } from "@/lib/food-drug-interactions";
import { meetsMinLifeStage, meetsMinAge } from "@/lib/life-stage";
import { dominantRxNormCandidate } from "@/lib/rxnorm";
import { collapsePrnDoses } from "@/lib/supplement-schedule";
import { prnDefaultsFor, redoseLabelDefaults } from "@/lib/prn-defaults";
import { resolveIntakePrefill } from "@/lib/intake-prefill";
import {
  medicationCatalogLabel,
  medicationCatalogOptions,
  catalogLabelGeneric,
  resolveMedicationPick,
  medicationBrandOptions,
  GENERIC_BRAND_OPTION,
} from "@/lib/medication-info";
import type { FoodTiming } from "@/lib/types";

// Follow-ups to the medications page (issue #851). One consolidated pure suite for the
// new label/matcher/prefill logic; the write-path + DB-tier + browser tiers cover the
// rest.

// ---- Item 4: age-aware food guidance ----
describe("#851 item 4 — food guidance is life-stage aware", () => {
  const warfarin = { name: "Warfarin", rxcui: null };

  it("shows the alcohol note for an adult / unknown age", () => {
    const adult = matchFoodInteractions(warfarin, 40).map((h) => h.food);
    expect(adult).toContain("Alcohol");
    const unknown = matchFoodInteractions(warfarin).map((h) => h.food);
    expect(unknown).toContain("Alcohol");
    const unknownNull = matchFoodInteractions(warfarin, null).map(
      (h) => h.food
    );
    expect(unknownNull).toContain("Alcohol");
  });

  it("never renders an alcohol line for a child profile", () => {
    for (const age of [3, 8, 12, 17]) {
      const foods = matchFoodInteractions(warfarin, age).map((h) => h.food);
      expect(foods, `age ${age}`).not.toContain("Alcohol");
    }
    // Acetaminophen also carries an alcohol rule — a child never sees it either.
    const kidAcet = matchFoodInteractions(
      { name: "Acetaminophen", rxcui: null },
      6
    ).map((h) => h.food);
    expect(kidAcet).not.toContain("Alcohol");
  });

  it("keeps non-age-gated guidance for a child (only alcohol is gated)", () => {
    // A grapefruit-class rule (no minLifeStage) still matches for a child.
    const kidStatin = matchFoodInteractions(
      { name: "Simvastatin", rxcui: null },
      8
    );
    expect(kidStatin.length).toBeGreaterThan(0);
    expect(kidStatin.some((h) => h.food === "Alcohol")).toBe(false);
  });

  it("meetsMinLifeStage / meetsMinAge follow the hide-only-on-positive-match policy", () => {
    expect(meetsMinLifeStage(null, "adult")).toBe(true); // unknown → eligible
    expect(meetsMinLifeStage(40, "adult")).toBe(true);
    expect(meetsMinLifeStage(10, "adult")).toBe(false);
    expect(meetsMinLifeStage(17, "adult")).toBe(false); // adolescent < adult
    expect(meetsMinAge(undefined, 21)).toBe(true);
    expect(meetsMinAge(25, 21)).toBe(true);
    expect(meetsMinAge(15, 21)).toBe(false);
  });
});

// ---- Item 12: age-aware interval/max prefill ----
describe("#851 item 12 — redose interval/max prefill is age-aware or refuses", () => {
  const ibuprofen = prnDefaultsFor({ name: "Ibuprofen", rxcui: null })!;
  const naproxen = prnDefaultsFor({ name: "Naproxen", rxcui: null })!;
  const child = {
    ageMonths: 60,
    weightKg: 18,
    weightDate: "2026-07-10",
    today: "2026-07-16",
  };

  it("returns the adult figures for an adult / unknown age", () => {
    const d = redoseLabelDefaults(ibuprofen, false);
    expect(d).toEqual({
      minIntervalHours: ibuprofen.adult.minIntervalHours,
      maxDailyCount: ibuprofen.adult.maxDailyCount,
      tier: "adult",
      source: ibuprofen.source,
    });
  });

  it("returns the pediatric figures for a child when the label carries them", () => {
    const d = redoseLabelDefaults(ibuprofen, true);
    expect(d?.tier).toBe("pediatric");
    expect(d?.minIntervalHours).toBe(ibuprofen.pediatric?.minIntervalHours);
    expect(d?.maxDailyCount).toBe(ibuprofen.pediatric?.maxDailyCount);
  });

  it("REFUSES (null) a child prefill when no pediatric label figure exists", () => {
    // Naproxen has no OTC pediatric block — never fall back to the adult numbers.
    expect(redoseLabelDefaults(naproxen, true)).toBeNull();
  });

  it("resolveIntakePrefill never gives a child an adult-only interval/max unlabeled", () => {
    // Ingredient WITH pediatric figures → child gets the pediatric ones (labeled).
    const acet = prnDefaultsFor({ name: "Acetaminophen", rxcui: null })!;
    const kidAcet = resolveIntakePrefill({
      info: null,
      prn: acet,
      pediatric: child,
    });
    expect(kidAcet.maxDailyCount).toBe(acet.pediatric?.maxDailyCount);
    expect(kidAcet.maxDailyCount).not.toBe(acet.adult.maxDailyCount);

    // Ingredient WITHOUT pediatric figures → child gets NO interval/max prefill.
    const kidNaproxen = resolveIntakePrefill({
      info: null,
      prn: naproxen,
      pediatric: child,
    });
    expect(kidNaproxen.minIntervalHours).toBeUndefined();
    expect(kidNaproxen.maxDailyCount).toBeUndefined();
    expect(kidNaproxen.marked).not.toContain("minIntervalHours");
    expect(kidNaproxen.marked).not.toContain("maxDailyCount");

    // An adult still gets the adult figures.
    const adultNaproxen = resolveIntakePrefill({ info: null, prn: naproxen });
    expect(adultNaproxen.minIntervalHours).toBe(
      naproxen.adult.minIntervalHours
    );
  });
});

// ---- Item 14: collapsed combobox options ----
describe("#851 item 14 — one option per med, 'Generic (Brand, Brand)'", () => {
  it("formats the label, capping brands at 2 + …", () => {
    expect(
      medicationCatalogLabel("Acetaminophen", ["Tylenol", "Panadol"])
    ).toBe("Acetaminophen (Tylenol, Panadol)");
    expect(
      medicationCatalogLabel("Ibuprofen", ["Advil", "Motrin", "Nurofen"])
    ).toBe("Ibuprofen (Advil, Motrin, …)");
    expect(medicationCatalogLabel("Metformin", [])).toBe("Metformin");
  });

  it("catalogLabelGeneric strips the parenthetical", () => {
    expect(catalogLabelGeneric("Acetaminophen (Tylenol, Panadol)")).toBe(
      "Acetaminophen"
    );
    expect(catalogLabelGeneric("Metformin")).toBe("Metformin");
  });

  it("returns one option per medication (no flat brand entries)", () => {
    const opts = medicationCatalogOptions();
    // A collapsed acetaminophen option exists exactly once, brands in the label.
    const acet = opts.filter((o) => o.startsWith("Acetaminophen"));
    expect(acet).toHaveLength(1);
    expect(acet[0]).toMatch(/^Acetaminophen \(/);
    // No BARE brand option ("Tylenol") on its own.
    expect(opts).not.toContain("Tylenol");
  });

  it("a brand-matched pick prefills the brand; a generic-matched pick does not", () => {
    const label = "Acetaminophen (Tylenol, Panadol)";
    const byBrand = resolveMedicationPick(label, "tyle");
    expect(byBrand.name).toBe("Acetaminophen");
    expect(byBrand.brand).toBe("Tylenol");

    const byGeneric = resolveMedicationPick(label, "acetamin");
    expect(byGeneric.name).toBe("Acetaminophen");
    expect(byGeneric.brand).toBeNull();

    // No query (keyboard pick) → generic only.
    expect(resolveMedicationPick(label).brand).toBeNull();
  });
});

// ---- Item 3: Generic brand option ----
describe("#851 item 3 — 'Generic' leads the brand options", () => {
  it("prepends Generic, ahead of a med's own brands, never duplicated", () => {
    const opts = medicationBrandOptions(["Advil", "Motrin"]);
    expect(opts[0]).toBe(GENERIC_BRAND_OPTION);
    expect(opts).toEqual(["Generic", "Advil", "Motrin"]);
    // A brand list that already contains "Generic" isn't duplicated.
    expect(medicationBrandOptions(["Generic", "Advil"])).toEqual([
      "Generic",
      "Advil",
    ]);
    // No specific list → the full catalog, still Generic-first.
    const full = medicationBrandOptions();
    expect(full[0]).toBe("Generic");
  });
});

// ---- Item 7: auto-confirm only an unambiguous RxNorm top match ----
describe("#851 item 7 — dominantRxNormCandidate auto-confirms unambiguous only", () => {
  it("confirms a single candidate", () => {
    expect(dominantRxNormCandidate([{ rxcui: "5640", score: 90 }])).toBe(
      "5640"
    );
  });
  it("confirms a 100-score top over a sub-100 runner-up", () => {
    expect(
      dominantRxNormCandidate([
        { rxcui: "5640", score: 100 },
        { rxcui: "999", score: 75 },
      ])
    ).toBe("5640");
  });
  it("confirms a dominant lead (≥20)", () => {
    expect(
      dominantRxNormCandidate([
        { rxcui: "a", score: 88 },
        { rxcui: "b", score: 60 },
      ])
    ).toBe("a");
  });
  it("refuses an ambiguous pair (close scores)", () => {
    expect(
      dominantRxNormCandidate([
        { rxcui: "a", score: 88 },
        { rxcui: "b", score: 80 },
      ])
    ).toBeNull();
  });
  it("refuses when two candidates both score 100", () => {
    expect(
      dominantRxNormCandidate([
        { rxcui: "a", score: 100 },
        { rxcui: "b", score: 100 },
      ])
    ).toBeNull();
  });
  it("returns null for an empty list (silent degrade)", () => {
    expect(dominantRxNormCandidate([])).toBeNull();
  });
});

// ---- Item 9: PRN ⇒ single amount-only dose ----
describe("#851 item 9 — collapsePrnDoses enforces the amount-only shape", () => {
  const rows = [
    {
      id: 1,
      amount: "200 mg",
      time_of_day: "Morning",
      food_timing: "with_food" as FoodTiming,
    },
    {
      id: 2,
      amount: "200 mg",
      time_of_day: "Evening",
      food_timing: "any" as FoodTiming,
    },
  ];

  it("collapses a PRN med to ONE amount-only row, keeping the first dose id + food timing", () => {
    const out = collapsePrnDoses(rows, true);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].amount).toBe("200 mg");
    expect(out[0].time_of_day).toBeNull();
    expect(out[0].food_timing).toBe("with_food");
  });

  it("is a no-op for a scheduled (non-PRN) med", () => {
    expect(collapsePrnDoses(rows, false)).toEqual(rows);
  });

  it("handles an empty PRN dose list", () => {
    const out = collapsePrnDoses(
      [] as {
        amount: string | null;
        time_of_day: string | null;
        food_timing: FoodTiming;
      }[],
      true
    );
    expect(out).toHaveLength(1);
    expect(out[0].time_of_day).toBeNull();
  });
});
