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

// A biomarker-driven excess caution attached to a low-side (ADD) entry (issue #775).
// GENERALIZES the omega-3 entry's STATIC pregnancy caution into one that ALSO fires on
// an out-of-range TOXIN/marker reading: an elevated mercury tempers the app's own fatty-
// fish encouragement ("prefer low-mercury species; avoid tuna/swordfish"). It rides the
// SAME suggestion (and dedupeKey) as the food it qualifies — it never stands alone — so
// it only matters when that food is actually being recommended. Mercury is a heavy metal
// with no RDA (not in dri.json), so it is handled here as a canonical-biomarker qualifier
// rather than through the nutrient-family/RDA path.
export interface ExcessCaution {
  // Canonical biomarker names whose HIGH/abnormal reading attaches this caution to the
  // suggestion (matched case-insensitively, via isHighFlag).
  biomarkers: string[];
  // The caution text surfaced as a biomarker safety note on the suggestion.
  note: string;
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
  // Biomarker-driven excess caution(s) that TEMPER this add suggestion when a related
  // toxin/marker reads high (issue #775) — e.g. omega-3 fatty-fish tempered by an
  // elevated mercury. Absent when none applies. Never a standalone suggestion.
  excessCaution?: ExcessCaution | null;
}

// One high-side (REDUCE) mapping (issue #775): a biomarker family whose CURRENT reading
// is flagged HIGH → the "limit"-tier foods to eat LESS of. The excess-direction twin of
// NutrientFoodEntry, consumed by the SAME pure engine (suggestFoods) and rendered by the
// SAME surfaces, so there is ONE engine with two directions — never a forked second
// engine. Coaching-tier, informational ("consider reducing X"), never prescriptive; it
// does NOT touch the care-tier UL (#148) / food–drug (#154) machinery. Its dedupeKey
// lives in its OWN namespace (`food-reduce:<key>`) so a reduce-note dismissal can never
// collide with an add-note one.
export interface ReduceFoodEntry {
  // Stable key for this reduce concept — the dedupeKey family (`food-reduce:<key>`), so
  // multiple flagged members (LDL-C + ApoB, Glucose + HbA1c) collapse to ONE suggestion
  // and a dismissal covers the family regardless of which member is newest (#482).
  key: string;
  // Display label ("LDL cholesterol / ApoB").
  label: string;
  // Canonical biomarker names whose CURRENT reading being flagged HIGH triggers this
  // reduce suggestion. Matched case-insensitively.
  biomarkers: string[];
  // Which flag direction triggers the suggestion — always "high" (this is the excess
  // direction; the low-side sibling is NutrientFoodEntry.direction === "low").
  direction: "high";
  // Ranked "limit"-tier foods to reduce (biggest lever first). `foodGroup` points at a
  // limit-tier slug in lib/food-groups.json where one exists, or null for a specific-
  // substance note (organ meats, deli meat) with no loggable group.
  foods: FoodSource[];
  // Plain-language reason ("LDL/ApoB respond to dietary saturated and trans fat").
  evidence: string;
  // Public, citable basis (NIH/NHLBI/NIDDK/NIAMS guidance, Dietary Guidelines).
  source: string;
  // Honest caveat (e.g. "blood sodium is regulated by fluid balance, not salt intake").
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
    excessCaution: {
      biomarkers: ["Mercury"],
      note: "Your mercury is elevated — prefer low-mercury fish (salmon, sardines, trout) and avoid high-mercury species (tuna, swordfish, king mackerel, shark) until it comes down.",
    },
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
  {
    key: "selenium",
    label: "Selenium",
    biomarkers: ["Selenium"],
    direction: "low",
    foods: [
      {
        food: "Brazil nuts",
        foodGroup: "nuts_seeds",
        serving:
          "Just 1–2 Brazil nuts a day cover the requirement — they are extraordinarily selenium-dense, so do NOT eat them by the handful.",
      },
      {
        food: "Sardines, tuna, and other seafood; eggs",
        foodGroup: "lean_fish",
        serving:
          "Seafood and eggs are steady, more moderate everyday selenium sources.",
      },
    ],
    evidence:
      "Brazil nuts are the most selenium-dense food (a single nut can exceed the daily requirement); seafood and eggs are reliable moderate sources.",
    source: "NIH ODS Selenium fact sheet",
    contraindications: [],
    allergyAlternative: {
      food: "Sardines, tuna, eggs, poultry, and whole grains",
      foodGroup: "lean_fish",
      serving: "Covers selenium without Brazil nuts for a nut allergy.",
    },
    caveat:
      "Selenium has a narrow safe range — a couple of Brazil nuts daily is plenty; routinely eating many can push intake toward toxic levels.",
  },
  {
    key: "zinc",
    label: "Zinc",
    biomarkers: ["Zinc"],
    direction: "low",
    foods: [
      {
        food: "Oysters, shellfish, red meat, and poultry",
        foodGroup: "shellfish",
        serving:
          "Oysters are by far the densest zinc source; red meat and poultry are reliable everyday sources.",
      },
      {
        food: "Legumes, nuts, seeds, and whole grains",
        foodGroup: "legumes",
        serving:
          "Plant zinc is less well absorbed; soaking or sprouting legumes and grains improves uptake.",
      },
    ],
    evidence:
      "Zinc is highest in oysters and other shellfish, red meat, and poultry; legumes, nuts, seeds, and whole grains contribute but are less bioavailable.",
    source: "NIH ODS Zinc fact sheet",
    contraindications: [],
    allergyAlternative: {
      food: "Legumes, nuts, seeds, and whole grains",
      foodGroup: "legumes",
      serving:
        "Covers zinc without shellfish for a shellfish allergy — soaking/sprouting improves absorption.",
    },
    caveat:
      "Very high zinc (usually from supplements, not food) blocks copper absorption — keep supplemental zinc modest.",
  },
  {
    key: "iodine",
    label: "Iodine",
    biomarkers: ["Iodine"],
    direction: "low",
    foods: [
      {
        food: "Iodized salt, dairy, and eggs",
        foodGroup: "dairy",
        serving:
          "Using iodized salt and including dairy and eggs covers iodine for most people.",
      },
      {
        food: "Seafood and (in moderation) seaweed",
        foodGroup: "lean_fish",
        serving:
          "Fish and shellfish are rich in iodine; seaweed is very concentrated, so use it sparingly.",
      },
    ],
    evidence:
      "Iodine comes mainly from iodized salt, dairy, eggs, seafood, and seaweed; plant content depends on soil iodine.",
    source: "NIH ODS Iodine fact sheet",
    contraindications: [
      {
        match: "hyperthyroid",
        caution:
          "With an overactive thyroid, extra iodine (especially seaweed/kelp) can worsen thyroid function — check with your clinician before increasing intake.",
      },
      {
        match: "hashimoto",
        caution:
          "With Hashimoto's thyroiditis, a sudden jump in iodine (kelp/seaweed supplements) can aggravate the condition — increase cautiously and with clinician guidance.",
      },
    ],
    allergyAlternative: {
      food: "Iodized salt, dairy, and eggs",
      foodGroup: "dairy",
      serving: "Covers iodine without seafood for a fish/shellfish allergy.",
    },
    caveat:
      "Both too little AND too much iodine harm the thyroid — seaweed can massively overshoot, so favor iodized salt and everyday foods over kelp supplements.",
  },
  {
    key: "calcium",
    label: "Calcium",
    biomarkers: ["Calcium"],
    direction: "low",
    foods: [
      {
        food: "Dairy — milk, yogurt, cheese",
        foodGroup: "dairy",
        serving:
          "Dairy is the densest, best-absorbed calcium source; a couple of servings a day covers most of the requirement.",
      },
      {
        food: "Fortified plant milks, calcium-set tofu, canned sardines with bones, and low-oxalate greens",
        foodGroup: "leafy_greens",
        serving:
          "Non-dairy calcium comes from fortified milks, calcium-set tofu, canned fish with bones, and greens like kale and bok choy.",
        foodDrugKeys: ["vitamin-k-warfarin"],
      },
    ],
    evidence:
      "Calcium is highest in dairy, with fortified plant milks, calcium-set tofu, canned fish with edible bones, and low-oxalate greens as effective non-dairy sources.",
    source: "NIH ODS Calcium fact sheet",
    contraindications: [
      {
        match: "hypercalcemia",
        caution:
          "With high blood calcium, do not increase calcium intake — this is a clinician-guided restriction.",
        severity: "drop",
      },
    ],
    allergyAlternative: {
      food: "Fortified plant milks, calcium-set tofu, canned sardines with bones, and leafy greens",
      foodGroup: "legumes",
      serving: "Covers calcium without dairy for a milk allergy.",
    },
    caveat:
      "Blood calcium is tightly regulated, so a low reading often reflects low albumin or vitamin D rather than diet — interpret it with your clinician.",
  },
  {
    key: "copper",
    label: "Copper",
    biomarkers: ["Copper"],
    direction: "low",
    foods: [
      {
        food: "Shellfish (oysters, crab), organ meats, nuts, and seeds",
        foodGroup: "shellfish",
        serving:
          "Shellfish and organ meats are the densest copper sources; nuts and seeds add steady amounts.",
      },
      {
        food: "Legumes, whole grains, and dark chocolate",
        foodGroup: "legumes",
        serving:
          "Beans, whole grains, and cocoa are good plant copper sources.",
      },
    ],
    evidence:
      "Copper is highest in shellfish, organ meats, nuts, seeds, legumes, whole grains, and cocoa.",
    source: "NIH ODS Copper fact sheet",
    contraindications: [
      {
        match: "wilson",
        caution:
          "With Wilson disease the body cannot clear copper — do NOT increase copper-rich foods; this is a clinician-guided restriction.",
        severity: "drop",
      },
    ],
    allergyAlternative: {
      food: "Legumes, whole grains, nuts, seeds, and dark chocolate",
      foodGroup: "legumes",
      serving: "Covers copper without shellfish for a shellfish allergy.",
    },
    caveat:
      "A low copper reading can be driven by high zinc intake (the two compete for absorption) — mention any zinc supplements to your clinician.",
  },
  {
    key: "vitamin-a",
    label: "Vitamin A",
    biomarkers: ["Vitamin A (Retinol)"],
    direction: "low",
    foods: [
      {
        food: "Eggs, dairy, and liver (preformed retinol)",
        foodGroup: "eggs",
        serving:
          "Eggs and dairy supply ready-to-use retinol; liver is extremely concentrated, so keep it occasional.",
      },
      {
        food: "Orange and dark-green vegetables — sweet potato, carrots, spinach (beta-carotene)",
        foodGroup: "other_vegetables",
        serving:
          "The body converts beta-carotene from colorful vegetables into vitamin A as needed.",
      },
    ],
    evidence:
      "Vitamin A comes as preformed retinol (eggs, dairy, liver) and as provitamin-A carotenoids (orange and dark-green vegetables) the body converts as needed.",
    source: "NIH ODS Vitamin A fact sheet",
    contraindications: [
      {
        match: "pregnan",
        caution:
          "In pregnancy, get vitamin A from beta-carotene vegetables rather than high-dose preformed retinol (liver or retinol supplements), which can harm the fetus in excess.",
      },
    ],
    allergyAlternative: null,
    caveat:
      "Beta-carotene from plants converts to vitamin A only as the body needs it and is not toxic; preformed retinol (liver, supplements) is the form to keep moderate.",
  },
  {
    key: "vitamin-e",
    label: "Vitamin E",
    biomarkers: [
      "Vitamin E (Alpha-Tocopherol)",
      "Vitamin E (Beta/Gamma-Tocopherol)",
    ],
    direction: "low",
    foods: [
      {
        food: "Nuts and seeds — almonds, sunflower seeds, hazelnuts",
        foodGroup: "nuts_seeds",
        serving:
          "A daily small handful of almonds or sunflower seeds is among the richest vitamin-E sources.",
      },
      {
        food: "Vegetable oils and leafy greens",
        foodGroup: "leafy_greens",
        serving:
          "Sunflower and safflower oils and dark greens add alpha-tocopherol.",
        foodDrugKeys: ["vitamin-k-warfarin"],
      },
    ],
    evidence:
      "Vitamin E (alpha-tocopherol) is concentrated in nuts, seeds, and vegetable oils, with smaller amounts in leafy greens.",
    source: "NIH ODS Vitamin E fact sheet",
    contraindications: [],
    allergyAlternative: {
      food: "Vegetable oils, leafy greens, avocado, and fortified cereals",
      foodGroup: "leafy_greens",
      serving: "Covers vitamin E without nuts or seeds for a nut/seed allergy.",
    },
    caveat:
      "High-dose vitamin E SUPPLEMENTS can raise bleeding risk with anticoagulants — food-level vitamin E does not, but tell your clinician before supplementing.",
  },
  {
    key: "vitamin-c",
    label: "Vitamin C",
    biomarkers: [],
    direction: "low",
    foods: [
      {
        food: "Citrus, peppers, kiwi, strawberries, and broccoli",
        foodGroup: "fruit",
        serving:
          "A daily serving of fruit or vegetables easily covers vitamin C; peppers and citrus are especially dense.",
      },
      {
        food: "Cruciferous and other vegetables",
        foodGroup: "cruciferous",
        serving: "Broccoli, Brussels sprouts, and tomatoes add vitamin C.",
      },
    ],
    evidence:
      "Vitamin C is widespread in fruits and vegetables — citrus, peppers, kiwi, berries, broccoli — and a produce-forward pattern covers it easily.",
    source: "NIH ODS Vitamin C fact sheet",
    contraindications: [
      {
        match: "hemochromatosis",
        caution:
          "Vitamin C boosts iron absorption — with iron-overload conditions (hemochromatosis), avoid large vitamin-C doses alongside iron-rich meals; discuss with your clinician.",
      },
    ],
    allergyAlternative: null,
    caveat:
      "Vitamin C has no routine blood biomarker in this app, so this entry surfaces on the supplement RDA-adequacy view rather than from a flagged lab — food easily covers the requirement.",
  },
  {
    key: "molybdenum",
    label: "Molybdenum",
    biomarkers: ["Molybdenum"],
    direction: "low",
    foods: [
      {
        food: "Legumes — beans, lentils, and peas",
        foodGroup: "legumes",
        serving:
          "Legumes are by far the richest molybdenum source; a serving most days more than covers the small requirement.",
      },
      {
        food: "Whole grains, nuts, and leafy greens",
        foodGroup: "whole_grains",
        serving: "Grains and nuts add steady molybdenum.",
      },
    ],
    evidence:
      "Molybdenum is highest in legumes, with whole grains, nuts, and leafy greens as secondary sources; dietary deficiency is very rare.",
    source: "NIH ODS Molybdenum fact sheet",
    contraindications: [],
    allergyAlternative: null,
    caveat:
      "Molybdenum deficiency is essentially unknown in people eating a normal diet — a low reading rarely calls for a dietary change.",
  },
];

// ── Curated high-side REDUCE table (issue #775) ───────────────────────────────
// The excess-direction twin of ENTRIES: a biomarker family flagged HIGH → the
// "limit"-tier foods to eat LESS of. Curated Mercury + core-panel trigger set (NOT a
// full symmetric inversion of every high biomarker) — a new trigger is a deliberate
// dataset addition later. Mercury is NOT here: as a heavy metal with no RDA it is
// handled as an ExcessCaution that TEMPERS the omega-3 fish suggestion, not as a
// standalone reduce entry. Public dietary facts from NIH institute guidance and the
// Dietary Guidelines for Americans. INFORMATIONAL, coaching-tier — human-review before
// trusting.
const REDUCE_ENTRIES: ReduceFoodEntry[] = [
  {
    key: "ldl-apob",
    label: "LDL cholesterol / ApoB",
    biomarkers: ["LDL Cholesterol", "ApoB"],
    direction: "high",
    foods: [
      {
        food: "Fried and deep-fried foods",
        foodGroup: "fried_food",
        serving:
          "Cutting back on fried food lowers the saturated and trans fat that raises LDL and ApoB.",
      },
      {
        food: "Processed and fatty red meats",
        foodGroup: "processed_meat",
        serving:
          "Swapping processed and fatty red meat for fish, poultry, or legumes reduces the saturated fat driving LDL up.",
      },
    ],
    evidence:
      "LDL cholesterol and ApoB respond to dietary saturated and trans fat; reducing fried foods and processed/fatty red meat is a well-established lever.",
    source:
      "NIH/NHLBI dietary guidance; Dietary Guidelines for Americans (limit saturated fat)",
    caveat:
      "Replacing saturated fat with unsaturated fats (olive oil, nuts, fish) lowers LDL more than simply cutting total fat.",
  },
  {
    key: "glucose",
    label: "Glucose / HbA1c",
    biomarkers: ["Glucose", "Hemoglobin A1c"],
    direction: "high",
    foods: [
      {
        food: "Added sugar and sweets",
        foodGroup: "added_sugar",
        serving:
          "Reducing added sugar lowers the post-meal glucose load that raises A1c.",
      },
      {
        food: "Sugary drinks — soda, juice, sweetened coffee",
        foodGroup: "sugary_drinks",
        serving:
          "Sugary drinks spike glucose fastest; swapping to water or unsweetened is a high-yield change.",
      },
      {
        food: "Refined grains — white bread, white rice, pastries",
        foodGroup: "refined_grains",
        serving:
          "Swapping refined grains for whole grains blunts glucose spikes.",
      },
    ],
    evidence:
      "Fasting glucose and HbA1c respond to dietary sugar and refined carbohydrate; reducing added sugar, sugary drinks, and refined grains lowers the glycemic load.",
    source:
      "NIH/NIDDK dietary guidance; Dietary Guidelines for Americans (limit added sugars)",
    caveat:
      "Fiber-rich whole foods, protein, and spreading carbohydrate across the day flatten glucose more than sugar avoidance alone.",
  },
  {
    key: "urate",
    label: "Uric acid",
    biomarkers: ["Uric Acid"],
    direction: "high",
    foods: [
      {
        food: "Alcohol, especially beer",
        foodGroup: "alcohol",
        serving:
          "Alcohol (beer most of all) raises uric acid and triggers gout flares — cutting back is a primary lever.",
      },
      {
        food: "High-purine foods — organ meats, red/game meat, and shellfish",
        foodGroup: null,
        serving:
          "Reducing organ meats, red and game meat, and shellfish lowers the purine load the body converts to uric acid.",
      },
      {
        food: "Sugary, high-fructose drinks",
        foodGroup: "sugary_drinks",
        serving:
          "Fructose raises uric acid, so cutting sugary drinks helps beyond the purine story.",
      },
    ],
    evidence:
      "High uric acid (and gout risk) responds to reducing alcohol, high-purine foods (organ meats, red meat, shellfish), and fructose-sweetened drinks.",
    source: "NIH/NIAMS gout dietary guidance",
    caveat:
      "Staying well hydrated and reaching a healthy weight lower uric acid alongside these changes; dairy and coffee are associated with lower levels.",
  },
  {
    key: "sodium",
    label: "Sodium",
    biomarkers: ["Sodium"],
    direction: "high",
    foods: [
      {
        food: "Processed and packaged salty foods",
        foodGroup: "processed_meat",
        serving:
          "Most dietary sodium comes from processed, packaged, and restaurant foods — choosing fresh or home-cooked is the biggest lever.",
      },
      {
        food: "Deli meats, canned soups, and salty snacks",
        foodGroup: null,
        serving:
          "Cutting back on deli meat, canned soup, chips, and salty sauces lowers sodium substantially.",
      },
    ],
    evidence:
      "Reducing processed and packaged foods — the source of most dietary sodium — is the primary lever, especially relevant with hypertension or reduced kidney function.",
    source:
      "NIH/NHLBI DASH guidance; Dietary Guidelines for Americans (limit sodium)",
    caveat:
      "A blood sodium reading is regulated mostly by fluid balance rather than salt intake — but reducing dietary sodium matters for blood pressure and kidney health.",
  },
];

export interface NutrientFoodMap {
  $comment: string;
  entries: NutrientFoodEntry[];
  reduceEntries: ReduceFoodEntry[];
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
      "curated food sources that address it (`entries`); and when a core-panel/toxin " +
      "biomarker reads high, the limit-tier foods to reduce (`reduceEntries`, issue " +
      "#775). Each carries an evidence note + source; low entries add contraindication " +
      "tags + an allergy alternative. Committed + HUMAN-REVIEWABLE. Regenerate with " +
      "`npm run gen:nutrient-food-map`. INFORMATIONAL food-first guidance, NOT medical " +
      "advice — every suggestion is safety-screened before it renders and cites the " +
      "flagged biomarker as its reason.",
    entries: ENTRIES,
    reduceEntries: REDUCE_ENTRIES,
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
