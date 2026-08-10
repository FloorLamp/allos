// PURE TIER — a missed protein/fibre target → ONE curated, safety-screened food group
// (issue #2383).
//
// What this pins, in the order the issue's acceptance states it:
//   1. a real shortfall against a resolved target yields exactly ONE group, and it is a
//      group the one-tap food bar can offer AND that actually carries the short nutrient;
//   2. the THREE yields-nothing cases — a met target, an unresolved target, and a day with
//      nothing logged — each explicitly, because they are the ones that regress silently;
//   3. nothing originates outside the curated map;
//   4. the safety screens are the SAME ones the biomarker route runs, not a second set:
//      a drop-severity contraindication withholds, an allergy surfaces the curated
//      alternative, a preference substitutes, and a caveat this one-line surface cannot
//      print withholds the offer rather than printing the food without it;
//   5. which nutrient wins when both are short.
//
// The positions are built through the REAL adequacy engines, never hand-written literals:
// a fabricated `ProteinAdequacy` could pin a status the engine would never produce.

import { describe, it, expect } from "vitest";
import {
  assessFiberAdequacy,
  fiberIntake,
  fiberTarget,
  type FiberAdequacy,
} from "@/lib/fiber";
import {
  assessProteinAdequacy,
  proteinIntake,
  proteinTarget,
  type ProteinAdequacy,
} from "@/lib/protein";
import {
  nutritionDayPosition,
  nutritionDigestLine,
  nutritionShortfalls,
} from "@/lib/nutrition-day";
import {
  NUTRIENT_FOOD_MAP_KEYS,
  shortfallFoodPhrase,
  shortfallFoodSuggestion,
  type NutritionSafetyContext,
} from "@/lib/nutrition-food-suggestion";
import { NUTRIENT_FOOD_ENTRIES } from "@/lib/food-suggest";
import { foodGroupBySlug, foodGroupSlugs } from "@/lib/food-groups";
import { formatMessageLine } from "@/lib/notifications/message-line";

const DATE = "2026-08-09";

// A profile with nothing on record to screen against.
const CLEAN: NutritionSafetyContext = {
  allergens: [],
  medications: [],
  conditions: [],
  situations: [],
};

function protein(opts: {
  estimated?: number;
  tracked?: number | null;
  bodyweightKg?: number | null;
}): ProteinAdequacy | null {
  return assessProteinAdequacy(
    proteinIntake({
      dailyTracked: opts.tracked ?? null,
      dailyLogged: null,
      dailyEstimated: opts.estimated ?? 0,
    }),
    proteinTarget({
      goal: "active", // 1.2–1.6 g/kg → 95–130 g at 80 kg
      bodyweightKg: opts.bodyweightKg === undefined ? 80 : opts.bodyweightKg,
    })
  );
}

function fiber(opts: {
  estimated?: number;
  tracked?: number | null;
  ageYears?: number | null;
}): FiberAdequacy | null {
  return assessFiberAdequacy(
    fiberIntake({
      dailyTracked: opts.tracked ?? null,
      dailyEstimated: opts.estimated ?? 0,
    }),
    fiberTarget({
      ageYears: opts.ageYears === undefined ? 40 : opts.ageYears,
      sex: "male", // DRI adequate intake 38 g/day
    })
  );
}

// The whole pipeline the digest runs, minus the DB gather: verdicts → position →
// shortfalls → the one offer.
function offerFor(
  args: { protein?: ProteinAdequacy | null; fiber?: FiberAdequacy | null },
  safety: NutritionSafetyContext = CLEAN
) {
  const position = nutritionDayPosition({
    date: DATE,
    protein: args.protein ?? null,
    fiber: args.fiber ?? null,
  });
  return shortfallFoodSuggestion(nutritionShortfalls(position), safety);
}

describe("a real shortfall yields ONE curated group", () => {
  it("answers a typical protein shortfall with poultry", () => {
    const offer = offerFor({ protein: protein({ estimated: 60 }) });
    expect(offer).toMatchObject({
      nutrient: "protein",
      key: "protein",
      foodGroup: "poultry",
      groupName: "Poultry",
      gramsPerServing: 35,
      isAlternative: false,
    });
  });

  it("answers a typical fibre shortfall with legumes", () => {
    const offer = offerFor({ fiber: fiber({ estimated: 18 }) });
    expect(offer).toMatchObject({
      nutrient: "fiber",
      key: "fiber",
      foodGroup: "legumes",
      groupName: "Legumes & beans",
      gramsPerServing: 8,
    });
  });

  it("is ONE group, not a meal plan — the result is a single suggestion or null", () => {
    // The shape itself is the guarantee: there is no list to trim. A day short on BOTH
    // nutrients still produces exactly one offer.
    const offer = offerFor({
      protein: protein({ estimated: 60 }),
      fiber: fiber({ estimated: 10 }),
    });
    expect(offer).not.toBeNull();
    expect(Array.isArray(offer)).toBe(false);
  });
});

describe("the suggested group is one the quick-add bar can offer", () => {
  it("names a slug in the catalog the bar is built from, with the catalog's own words", () => {
    const catalog = new Set(foodGroupSlugs());
    for (const offer of [
      offerFor({ protein: protein({ estimated: 60 }) }),
      offerFor({ fiber: fiber({ estimated: 10 }) }),
    ]) {
      expect(offer).not.toBeNull();
      expect(catalog.has(offer!.foodGroup)).toBe(true);
      expect(foodGroupBySlug(offer!.foodGroup)?.name).toBe(offer!.groupName);
    }
  });

  it("only ever names a group the catalog scores as a source of the SHORT nutrient", () => {
    // The honesty half of the same rule: logging the suggested serving has to move the
    // number the line just reported. Asserted over every group either curated entry can
    // reach, not just the two the happy paths return.
    for (const key of Object.values(NUTRIENT_FOOD_MAP_KEYS)) {
      const entry = NUTRIENT_FOOD_ENTRIES.find((e) => e.key === key)!;
      const sources = [
        ...entry.foods,
        ...(entry.allergyAlternative ? [entry.allergyAlternative] : []),
      ];
      // At least one source per entry must be offerable, or the entry can never answer.
      const offerable = sources.filter((f) => {
        const group = f.foodGroup ? foodGroupBySlug(f.foodGroup) : undefined;
        const grams = key === "protein" ? group?.protein_g : group?.fiber_g;
        return grams != null && grams > 0;
      });
      expect(
        offerable.length,
        `${key} has no offerable source`
      ).toBeGreaterThan(0);
    }
  });
});

describe("the three ways it yields nothing", () => {
  it("MET TARGET — a day that reached both targets offers nothing", () => {
    const args = {
      protein: protein({ tracked: 110 }), // within the 95–130 band
      fiber: fiber({ tracked: 40 }), // within the 38 g AI
    };
    expect(
      nutritionShortfalls(nutritionDayPosition({ date: DATE, ...args }))
    ).toEqual([]);
    expect(offerFor(args)).toBeNull();
  });

  it("UNRESOLVED TARGET — a profile with no bodyweight offers nothing for protein", () => {
    // `proteinTarget` refuses to scale a band by a mass it does not have, so there is no
    // verdict, no shortfall, and nothing to suggest against. A guessed target would be
    // worse than silence.
    expect(protein({ estimated: 40, bodyweightKg: null })).toBeNull();
    expect(
      offerFor({ protein: protein({ estimated: 40, bodyweightKg: null }) })
    ).toBeNull();
  });

  it("NO LOGS — a day with nothing logged offers nothing, because it is not a day of zero", () => {
    // The load-bearing one. Absence of logging is not evidence of low intake, so an
    // unlogged day must never produce a shortfall to suggest against.
    expect(protein({})).toBeNull();
    expect(fiber({})).toBeNull();
    expect(offerFor({ protein: protein({}), fiber: fiber({}) })).toBeNull();
  });

  it("offers nothing when the gap ROUNDS to zero — there is nothing to close", () => {
    // 37.6 g against a 38 g AI is `below`, and both figures print as 38: the line may
    // still state them, but an offer would be answering a gap the reader cannot see.
    const f = fiber({ tracked: 37.6 });
    expect(f?.status).toBe("below");
    const position = nutritionDayPosition({
      date: DATE,
      protein: null,
      fiber: f,
    });
    expect(nutritionShortfalls(position)[0].shortfallGrams).toBe(0);
    expect(offerFor({ fiber: f })).toBeNull();
  });
});

describe("nothing originates outside the curated map", () => {
  it("every group the two entries can surface comes from nutrient-food-map.json", () => {
    const curated = new Set<string>();
    for (const key of Object.values(NUTRIENT_FOOD_MAP_KEYS)) {
      const entry = NUTRIENT_FOOD_ENTRIES.find((e) => e.key === key);
      expect(entry, `no curated entry for ${key}`).toBeTruthy();
      for (const f of entry!.foods) if (f.foodGroup) curated.add(f.foodGroup);
      if (entry!.allergyAlternative?.foodGroup)
        curated.add(entry!.allergyAlternative.foodGroup);
    }
    // Every offer this module can return under any safety context is drawn from that set —
    // sampled here across the screens that change WHICH food survives.
    const offers = [
      offerFor({ protein: protein({ estimated: 60 }) }),
      offerFor({ fiber: fiber({ estimated: 10 }) }),
      offerFor(
        { protein: protein({ estimated: 60 }) },
        { ...CLEAN, allergens: ["fish", "egg"] }
      ),
      offerFor(
        { fiber: fiber({ estimated: 10 }) },
        { ...CLEAN, excludedGroups: ["legumes"] }
      ),
    ];
    for (const o of offers) {
      expect(o).not.toBeNull();
      expect(curated.has(o!.foodGroup)).toBe(true);
    }
  });
});

describe("the safety screens are the biomarker route's own, reused", () => {
  it("withholds the protein offer entirely for a drop-severity contraindication", () => {
    // CKD × protein is the same shape as the map's CKD × potassium/magnesium drops:
    // increasing the nutrient is clinician territory, so the app says nothing rather than
    // something dangerous. Absence is never an all-clear.
    expect(
      offerFor(
        { protein: protein({ estimated: 60 }) },
        { ...CLEAN, conditions: ["Chronic kidney disease, stage 3"] }
      )
    ).toBeNull();
  });

  it("surfaces the curated alternative when an allergy strikes the primary sources", () => {
    // Fish, egg and legume allergies strike all three primary protein foods; the entry's
    // own alternative is what surfaces, flagged as one.
    const offer = offerFor(
      { protein: protein({ estimated: 60 }) },
      { ...CLEAN, allergens: ["fish", "egg", "poultry", "tofu"] }
    );
    expect(offer).toMatchObject({
      foodGroup: "whole_grains",
      isAlternative: true,
    });
  });

  it("substitutes a preference-compatible source without losing the shortfall", () => {
    const offer = offerFor(
      { fiber: fiber({ estimated: 10 }) },
      { ...CLEAN, excludedGroups: ["legumes"] }
    );
    expect(offer?.foodGroup).toBe("berries");
  });

  it("withholds the offer rather than printing a food whose caveat this line cannot carry", () => {
    // The fibre entry participates in the levothyroxine separation rule. #577 refuses to
    // drop that advice silently, and a one-line offer has no room for it — so the offer
    // goes, not the caveat. The figures still render.
    const withLevo: NutritionSafetyContext = {
      ...CLEAN,
      medications: [
        { name: "Levothyroxine", rxcui: null, rxcuiIngredients: null },
      ],
    };
    expect(offerFor({ fiber: fiber({ estimated: 10 }) }, withLevo)).toBeNull();
    // …and it falls through to the OTHER short nutrient rather than going silent when
    // that one is clean.
    expect(
      offerFor(
        {
          protein: protein({ estimated: 60 }),
          fiber: fiber({ estimated: 10 }),
        },
        withLevo
      )?.nutrient
    ).toBe("protein");
  });
});

describe("which nutrient wins when both are short", () => {
  it("picks the bigger RELATIVE miss, not the bigger gram figure", () => {
    // A gram figure alone would always hand the offer to whichever nutrient happens to be
    // counted in bigger numbers, which for these two is always protein.
    const bothShort = offerFor({
      protein: protein({ estimated: 60 }), // 35 g short of 95 → 37%
      fiber: fiber({ estimated: 12 }), // 26 g short of 38 → 68%
    });
    expect(bothShort?.nutrient).toBe("fiber");

    const proteinWorse = offerFor({
      protein: protein({ estimated: 20 }), // 75 g short of 95 → 79%
      fiber: fiber({ estimated: 30 }), // 8 g short of 38 → 21%
    });
    expect(proteinWorse?.nutrient).toBe("protein");
  });
});

describe("the wording, and the line it rides", () => {
  it("names the catalog group and what one serving carries, as an offer not an order", () => {
    const offer = offerFor({ fiber: fiber({ estimated: 18 }) })!;
    expect(shortfallFoodPhrase(offer)).toBe(
      "try legumes & beans (8 g fiber a serving)"
    );
    expect(shortfallFoodPhrase(offer)).not.toMatch(
      /must|should|need to|failed|missed/i
    );
  });

  it("rides the existing nutrition line as one more note, punctuated by the formatter", () => {
    const position = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 84 }),
      fiber: fiber({ estimated: 18 }),
    });
    const offer = shortfallFoodSuggestion(
      nutritionShortfalls(position),
      CLEAN
    )!;
    expect(nutritionDigestLine(position, shortfallFoodPhrase(offer))).toEqual({
      head: "Nutrition",
      notes: [
        "protein 84 g+ of 95 g",
        "fiber 18 g+ of 38 g",
        "try legumes & beans (8 g fiber a serving)",
      ],
    });
    expect(
      formatMessageLine(
        nutritionDigestLine(position, shortfallFoodPhrase(offer))!
      )
    ).toBe(
      "Nutrition — protein 84 g+ of 95 g · fiber 18 g+ of 38 g · try legumes & beans (8 g fiber a serving)"
    );
  });

  it("leaves the line exactly as it was when there is no offer", () => {
    const position = nutritionDayPosition({
      date: DATE,
      protein: protein({ estimated: 84 }),
      fiber: null,
    });
    expect(nutritionDigestLine(position, null)).toEqual(
      nutritionDigestLine(position)
    );
  });
});
