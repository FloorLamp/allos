// Pre-generate the baked biomarker→nutrient→food map (lib/nutrient-food-map.json)
// used by the DETERMINISTIC food-recommendation engine (issue #577): when a profile's
// current reading for a diet-responsive biomarker family is flagged low, suggest the
// food sources that address it — safety-screened against allergies, medications, and
// conditions. This is the OUTPUT half of the nutrition umbrella (#576); it is the food
// twin of the supplement-suggestion safety belt, but the suggestions themselves come
// ONLY from this curated, human-reviewable table — never from free AI generation.
//
// Mirrors the gen-mets.ts → lib/mets.json and gen-dri.ts → lib/dri.json pattern: the
// JSON is COMMITTED and HUMAN-REVIEWABLE, and every mapping carries a plain-language
// evidence note and a SOURCE citation. Like gen-mets/gen-dri this needs NO API key —
// the nutrient→food links are well-established dietary facts curated inline, so
// generation is fully deterministic:
//
//   npm run gen:nutrient-food-map
//
// FRAMING (load-bearing): every entry is INFORMATIONAL, food-first lifestyle guidance,
// NOT medical advice or a prescription. The engine cites the flagged biomarker as its
// reason; the copy discipline is the food–drug matcher's verbatim ("discuss with your
// clinician"). Vitamin D is included honestly as a case where FOOD is a minor lever
// (sunlight/supplements dominate) — the entry says so.
//
// SAFETY (see lib/food-suggest.ts): each entry carries `contraindications` (condition/
// situation tags checked against the profile's conditions + risk-stratification), and
// an `allergyAlternative` for the allergen case (a fish allergy strikes fatty fish and
// the alternative surfaces instead). Medication conflicts are checked separately by
// inverting lib/food-drug-interactions.json (same dataset, second consumer).
//
// Anti-drift: the committed lib/nutrient-food-map.json is a FIXED POINT of
// buildNutrientFoodMap() and every biomarker name / food-group slug it references is
// pinned by lib/__tests__/nutrient-food-map-dataset.test.ts, so the generator and the
// committed file can't silently diverge, and a food_group link that doesn't resolve
// into lib/food-groups.json fails the build.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "nutrient-food-map.json");

// One food source addressing a nutrient shortfall. `foodGroup` is the stable slug in
// lib/food-groups.json (issue #579) so a logged serving and a suggestion speak the
// same vocabulary; `serving` is the evidence-shaped guidance ("2 servings/week").
export interface FoodSource {
  // Display label for the food ("Fatty fish (salmon, sardines, mackerel)").
  food: string;
  // Stable food-group slug this food belongs to (resolves into lib/food-groups.json),
  // or null for a food not tracked as a loggable group (e.g. a pairing note target).
  foodGroup: string | null;
  // Serving-level guidance in the shape dietary evidence actually takes.
  serving: string;
  // The lib/food-drug-interactions.json entry keys this food PARTICIPATES in — the
  // INVERSE index (#577): "before recommending food Y, check the stack against it."
  // When a stack medication matches one of these keys, the suggestion carries that
  // rule's advice as a medication safety note (never dropped silently). Absent/empty
  // for a food with no notable drug interaction.
  foodDrugKeys?: string[];
}

// One biomarker-family → nutrient → foods mapping.
export interface NutrientFoodEntry {
  // Stable key for this nutrient concept — the food-suggestion dedupeKey family
  // (`food-suggest:<key>`), so multiple flagged members collapse to one suggestion and
  // a dismissal covers the family regardless of which member is newest (#482).
  key: string;
  // Display label for the nutrient ("Omega-3 (EPA/DHA)").
  label: string;
  // The canonical biomarker names (lib/canonical-biomarkers.json) whose CURRENT reading
  // being flagged in `direction` triggers this suggestion. Matched case-insensitively.
  biomarkers: string[];
  // Which flag direction triggers the suggestion. "low" = below the reference/optimal
  // range (the diet-addressable case); we never suggest eating MORE of something for a
  // HIGH reading.
  direction: "low";
  // Ranked food sources (best lever first).
  foods: FoodSource[];
  // A one-line, plain-language reason ("Fatty fish is the richest dietary source of
  // the long-chain omega-3s EPA and DHA that the omega-3 index measures.").
  evidence: string;
  // Where the evidence comes from — a public, citable reference (NIH ODS fact sheet,
  // dietary guideline). INFORMATIONAL, human-review before trusting.
  source: string;
  // Condition/situation contraindication tags. Checked (substring, case-insensitive)
  // against the profile's active conditions AND active situations; a hit annotates or
  // caps the suggestion rather than dropping it (the annotation carries the caution).
  contraindications: Contraindication[];
  // The food to surface INSTEAD when an allergy strikes every primary food (e.g. algae
  // oil / walnuts + flaxseed for a fish allergy). Null when there is no clean swap.
  allergyAlternative: FoodSource | null;
  // Honest caveat surfaced in the suggestion detail — e.g. "Food is a minor lever for
  // vitamin D; sunlight and supplements dominate." Null when none applies.
  caveat: string | null;
}

// A condition/situation caution attached to a nutrient entry. `match` is the term
// checked against conditions/situations; `caution` is the annotation shown when it
// hits (never a silent drop — the user sees the reason).
export interface Contraindication {
  // Lowercase term matched (substring) against condition names + active situations.
  match: string;
  // The caution shown when it hits.
  caution: string;
  // "caution" (default) annotates the suggestion with the caution but still shows the
  // food; "drop" withholds the whole suggestion — used where increasing the nutrient
  // is actively hazardous for the condition (CKD/hyperkalemia + potassium), so the
  // right call is to say nothing rather than suggest something dangerous. Absence of a
  // suggestion is never an all-clear (the engine never claims safety).
  severity?: "caution" | "drop";
}

// ── Curated biomarker → nutrient → food table ─────────────────────────────────
// Diet-responsive analytes only, each with a genuine food lever. Public dietary facts
// from the NIH Office of Dietary Supplements nutrient fact sheets
// (https://ods.od.nih.gov/factsheets/list-all/) and the Dietary Guidelines for
// Americans. INFORMATIONAL — human-review before trusting.
const ENTRIES: NutrientFoodEntry[] = [
  {
    key: "omega-3",
    label: "Omega-3 (EPA/DHA)",
    biomarkers: [
      "Omega-3 Total (OmegaCheck)",
      "Omega-3 EPA",
      "Omega-3 DHA",
      "Omega-3 DPA",
    ],
    direction: "low",
    foods: [
      {
        food: "Fatty fish (salmon, sardines, mackerel, herring)",
        foodGroup: "fatty_fish",
        serving: "About 2 servings a week (roughly 8 oz total).",
      },
    ],
    evidence:
      "Fatty fish is the richest dietary source of the long-chain omega-3s EPA and DHA that the omega-3 index reflects; two servings a week is the commonly cited target.",
    source:
      "NIH ODS Omega-3 Fatty Acids fact sheet; Dietary Guidelines for Americans (seafood 8 oz/week)",
    contraindications: [
      {
        match: "pregnan",
        caution:
          "During pregnancy, prefer low-mercury species (salmon, sardines) and keep to ~8–12 oz/week; avoid high-mercury fish.",
      },
    ],
    allergyAlternative: {
      food: "Walnuts, ground flaxseed, chia (ALA) or algae-oil omega-3",
      foodGroup: "nuts_seeds",
      serving:
        "A daily small handful of walnuts / tablespoon of ground flax; algae oil supplies EPA/DHA directly without fish.",
    },
    caveat:
      "Plant ALA (flax, walnuts) converts to EPA/DHA only weakly — algae oil is the fish-free way to get EPA/DHA directly.",
  },
  {
    key: "iron",
    label: "Iron",
    biomarkers: ["Ferritin", "Iron"],
    direction: "low",
    foods: [
      {
        food: "Lean red meat, poultry, shellfish (heme iron)",
        foodGroup: "red_meat",
        serving:
          "Heme iron from animal foods is absorbed far better than plant iron; a couple of servings a week helps rebuild stores.",
      },
      {
        food: "Legumes, lentils, tofu, dark leafy greens (non-heme iron)",
        foodGroup: "legumes",
        serving:
          "Pair plant iron with a vitamin-C food (citrus, peppers, tomatoes) in the same meal to boost absorption.",
        foodDrugKeys: ["vitamin-k-warfarin"],
      },
    ],
    evidence:
      "Low ferritin/iron responds to dietary iron; heme iron (meat) is best absorbed, and pairing plant iron with vitamin C markedly improves uptake.",
    source: "NIH ODS Iron fact sheet",
    contraindications: [],
    allergyAlternative: null,
    caveat:
      "A vitamin-C food in the same meal (and avoiding tea/coffee with it) meaningfully raises non-heme iron absorption.",
  },
  {
    key: "vitamin-b12",
    label: "Vitamin B12",
    biomarkers: ["Vitamin B12"],
    direction: "low",
    foods: [
      {
        food: "Fish, meat, eggs, dairy (and fortified foods)",
        foodGroup: "red_meat",
        serving:
          "B12 occurs naturally only in animal foods; fortified cereals or nutritional yeast cover a plant-based diet.",
      },
    ],
    evidence:
      "B12 is found naturally only in animal foods; a plant-based diet relies on fortified foods or a supplement.",
    source: "NIH ODS Vitamin B12 fact sheet",
    contraindications: [],
    allergyAlternative: {
      food: "Fortified cereals, fortified plant milks, nutritional yeast",
      foodGroup: null,
      serving: "The reliable B12 route on a diet that excludes animal foods.",
    },
    caveat:
      "Absorption falls with age and with acid-lowering medication — a persistent low often needs a supplement, not just food.",
  },
  {
    key: "folate",
    label: "Folate",
    biomarkers: ["Folate", "Folate, RBC"],
    direction: "low",
    foods: [
      {
        food: "Legumes, lentils, and dark leafy greens",
        foodGroup: "legumes",
        serving:
          "Legumes and leafy greens are among the densest natural folate sources; include them most days.",
      },
      {
        food: "Leafy greens (spinach, romaine), asparagus, avocado",
        foodGroup: "leafy_greens",
        serving: "A daily serving of greens adds meaningful folate.",
        foodDrugKeys: ["vitamin-k-warfarin"],
      },
    ],
    evidence:
      "Folate is highest in legumes and leafy greens (the vitamin is named for foliage); fortified grains add more.",
    source: "NIH ODS Folate fact sheet",
    contraindications: [],
    allergyAlternative: null,
    caveat: null,
  },
  {
    key: "magnesium",
    label: "Magnesium",
    biomarkers: ["Magnesium", "Magnesium, RBC"],
    direction: "low",
    foods: [
      {
        food: "Nuts, seeds (pumpkin, almonds), and whole grains",
        foodGroup: "nuts_seeds",
        serving:
          "A daily small handful of nuts or seeds is a dense magnesium source.",
      },
      {
        food: "Legumes and dark leafy greens",
        foodGroup: "legumes",
        serving: "Beans, lentils, and greens add steady magnesium.",
      },
    ],
    evidence:
      "Magnesium is concentrated in nuts, seeds, whole grains, legumes, and leafy greens — a whole-food-forward pattern covers it.",
    source: "NIH ODS Magnesium fact sheet",
    contraindications: [
      {
        match: "chronic kidney",
        caution:
          "With reduced kidney function, magnesium can accumulate — check with your clinician before increasing intake.",
        severity: "drop",
      },
    ],
    allergyAlternative: {
      food: "Whole grains, legumes, and leafy greens",
      foodGroup: "whole_grains",
      serving: "Covers magnesium without nuts or seeds for a nut/seed allergy.",
    },
    caveat: null,
  },
  {
    key: "potassium",
    label: "Potassium",
    biomarkers: ["Potassium"],
    direction: "low",
    foods: [
      {
        food: "Fruits (bananas, oranges), potatoes, and legumes",
        foodGroup: "legumes",
        serving:
          "Potassium is spread across produce — fruit, potatoes, beans, and greens most days.",
      },
      {
        food: "Leafy greens and tomatoes",
        foodGroup: "leafy_greens",
        serving: "Greens and tomato products are potassium-dense.",
        foodDrugKeys: ["vitamin-k-warfarin"],
      },
    ],
    evidence:
      "Potassium is widespread in fruit, vegetables, potatoes, and legumes; a produce-forward pattern raises it.",
    source: "NIH ODS Potassium fact sheet",
    contraindications: [
      {
        match: "chronic kidney",
        caution:
          "With reduced kidney function, extra potassium can be dangerous — do NOT increase intake without your clinician's guidance.",
        severity: "drop",
      },
      {
        match: "hyperkalemia",
        caution:
          "With high potassium, do not increase potassium-rich foods — this is a clinician-guided restriction.",
        severity: "drop",
      },
    ],
    allergyAlternative: null,
    caveat: null,
  },
  {
    key: "vitamin-d",
    label: "Vitamin D",
    biomarkers: ["Vitamin D, 25-Hydroxy"],
    direction: "low",
    foods: [
      {
        food: "Fatty fish, egg yolks, and fortified milk/cereals",
        foodGroup: "fatty_fish",
        serving:
          "Fatty fish and fortified foods add some vitamin D, but food alone rarely corrects a real deficiency.",
      },
    ],
    evidence:
      "Few foods contain much vitamin D; fatty fish and fortified products are the main dietary sources.",
    source: "NIH ODS Vitamin D fact sheet",
    contraindications: [],
    allergyAlternative: {
      food: "Fortified plant milks and cereals; UV-exposed mushrooms",
      foodGroup: null,
      serving: "Fish-free dietary vitamin D, though modest.",
    },
    caveat:
      "Food is a MINOR lever for vitamin D — sunlight and supplements dominate. A flagged-low 25-OH-D usually needs sun exposure or a supplement, not just diet.",
  },
];

export interface NutrientFoodMap {
  $comment: string;
  entries: NutrientFoodEntry[];
}

// Pure builder: assemble the map from the curated table. The committed
// lib/nutrient-food-map.json is a FIXED POINT of this (guarded by the dataset test),
// so the generator and committed file can't silently diverge. Entries are emitted in
// curated order for a stable, reviewable diff.
export function buildNutrientFoodMap(): NutrientFoodMap {
  return {
    $comment:
      "Baked biomarker→nutrient→food map for the DETERMINISTIC food-recommendation " +
      "engine (issue #577): when a diet-responsive biomarker family reads low, the " +
      "curated food sources that address it, each with an evidence note + source, " +
      "contraindication tags, and an allergy alternative. Committed + HUMAN-REVIEWABLE. " +
      "Regenerate with `npm run gen:nutrient-food-map`. INFORMATIONAL food-first " +
      "guidance, NOT medical advice — every suggestion is safety-screened before it " +
      "renders and cites the flagged biomarker as its reason.",
    entries: ENTRIES,
  };
}

function writeDataset(): void {
  const dataset = buildNutrientFoodMap();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(
    `Wrote ${dataset.entries.length} nutrient→food entries to ${OUT}`
  );
  console.log(
    "Review the food mappings + sources for accuracy before committing."
  );
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test imports
// buildNutrientFoodMap).
if (process.argv[1]?.includes("gen-nutrient-food-map")) {
  writeDataset();
}
