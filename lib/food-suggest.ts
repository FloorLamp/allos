// The DETERMINISTIC biomarker→food suggestion engine (issue #577), the OUTPUT half of
// the nutrition umbrella (#576). When a profile's CURRENT reading for a diet-responsive
// biomarker family is flagged low, this proposes the curated food sources that address
// it (lib/nutrient-food-map.json) — each suggestion safety-screened against the
// profile's allergies, medications, and conditions/situations BEFORE it renders.
//
// This is the food twin of lib/supplement-suggest.ts, but with a load-bearing
// difference: the suggestions come ONLY from the curated, human-reviewable map — never
// from free AI generation. The engine here is PURE (no DB/network/clock): the DB gather
// lives in lib/queries/nutrition.ts (getFoodSuggestions), which both surfaces (the
// biomarker detail page and the coaching tab) format — "one question, one computation."
//
// Safety screens (each reuses/inverts existing machinery):
//   • Allergies — allergenConflict (lib/supplement-safety.ts): direct + cross-reactive
//     matching. A fish allergy strikes fatty fish and the entry's alternative surfaces
//     instead.
//   • Medications — the INVERSE of lib/datasets/data/food-drug-interactions.json: each food declares
//     the interaction-entry keys it participates in (`foodDrugKeys`); a stack med that
//     matches one attaches that rule's advice as a note (a warfarin profile's leafy-
//     greens suggestion carries the consistency-matters vitamin-K note — never dropped
//     silently).
//   • Conditions/situations — each entry's contraindication tags checked against active
//     conditions + situations. A "drop"-severity hit (CKD/hyperkalemia + potassium)
//     withholds the whole suggestion; a "caution" hit annotates it (pregnancy + fatty
//     fish → low-mercury note).
//
// Framing is informational, food-first, never prescriptive — and the ABSENCE of a
// suggestion is never an all-clear.
//
// Tier: coaching (#449). The finding's dedupeKey is `food-suggest:<nutrientKey>`, keyed
// on the NUTRIENT so multiple flagged members of the same nutrient family (Omega-3
// Total/EPA/DHA) collapse to ONE suggestion and a dismissal covers the family
// regardless of which member is newest (#482). The prefix is registered in
// lib/rule-finding-prefixes.ts.

import type {
  NutrientFoodEntry,
  ReduceFoodEntry,
  FoodSource,
} from "@/scripts/gen-nutrient-food-map";
import {
  NUTRIENT_FOOD_ENTRIES,
  REDUCE_FOOD_ENTRIES,
} from "./datasets/nutrient-food-map";
import { allergenConflict, type SafetyMedication } from "./supplement-safety";
import { matchFoodInteractions } from "./food-drug-interactions";

const ENTRIES: NutrientFoodEntry[] = NUTRIENT_FOOD_ENTRIES;
const REDUCE_ENTRIES: ReduceFoodEntry[] = REDUCE_FOOD_ENTRIES;

// The findings-bus namespace for low-side (ADD) food suggestions (issue #435/#482).
// Keyed on the nutrient, so a dismiss follows the nutrient family, not a single reading.
export const FOOD_SUGGEST_PREFIX = "food-suggest:";

export function foodSuggestSignalKey(nutrientKey: string): string {
  return `${FOOD_SUGGEST_PREFIX}${nutrientKey}`;
}

// The findings-bus namespace for high-side (REDUCE) food suggestions (issue #775). A
// SEPARATE namespace from FOOD_SUGGEST_PREFIX so a reduce-note dismissal can never
// collide with an add-note one, even for the same underlying biomarker. Keyed on the
// reduce family, so a dismiss covers the family (LDL-C + ApoB) regardless of which
// flagged member is newest (#482).
export const FOOD_REDUCE_PREFIX = "food-reduce:";

export function foodReduceSignalKey(reduceKey: string): string {
  return `${FOOD_REDUCE_PREFIX}${reduceKey}`;
}

// A flag string is "low-side" when the current reading is below its reference or
// optimal range — the only direction diet can address by ADDING a food.
export function isLowFlag(flag: string | null | undefined): boolean {
  const f = (flag ?? "").trim().toLowerCase();
  return f === "low" || f === "non-optimal-low";
}

// A flag string is "high-side" when the current reading is above its reference or
// optimal range, or qualitatively abnormal (a toxin/heavy-metal panel reports "high"
// or "abnormal"). The direction diet addresses by REDUCING a food (issue #775) — the
// deliberate other half of the one-directional #577 engine. The mirror of isLowFlag.
export function isHighFlag(flag: string | null | undefined): boolean {
  const f = (flag ?? "").trim().toLowerCase();
  return f === "high" || f === "non-optimal-high" || f === "abnormal";
}

// One currently-flagged reading the engine considers — name + its flag. Shaped to
// accept a CurrentFlaggedReading (lib/queries/medical.ts) directly.
export interface FlaggedReading {
  name: string;
  flag: string | null;
}

export interface FoodSuggestInput {
  // Currently-flagged biomarker readings (family-collapsed, current-only per #557).
  flagged: FlaggedReading[];
  // Recorded allergen substances (getAllergies(...).map(a => a.substance)).
  allergens: string[];
  // The active stack's medications, for the food–drug inverse screen.
  medications: SafetyMedication[];
  // Active condition names (getConditions(..., { status: "active" }).map(c => c.name)).
  conditions: string[];
  // Active situation names (getActiveSituations(...)).
  situations: string[];
}

export type FoodSafetyNoteKind =
  | "allergy"
  | "medication"
  | "condition"
  // A biomarker-driven excess caution (issue #775) — e.g. an elevated mercury
  // tempering the fatty-fish suggestion. Rendered like a condition caution.
  | "biomarker";

export interface FoodSafetyNote {
  kind: FoodSafetyNoteKind;
  text: string;
}

export interface SuggestedFood {
  food: string;
  foodGroup: string | null;
  serving: string;
  // True when this food is surfaced as the allergy ALTERNATIVE (the primary foods were
  // struck by an allergy) rather than a primary source.
  isAlternative: boolean;
}

export interface FoodSuggestion {
  // Nutrient / reduce key (the dedupe family).
  key: string;
  label: string;
  // Which direction this suggestion is: "add" (a low reading → eat MORE of a food) or
  // "reduce" (a high reading → eat LESS of a limit-tier food, issue #775). The surfaces
  // format the framing off this ("Food for …" vs "Cut back for …", low vs high).
  direction: "add" | "reduce";
  // `food-suggest:<key>` (add) or `food-reduce:<key>` (reduce) — the findings-bus
  // dedupeKey (family-keyed, #482; separate namespaces so the two can't collide).
  dedupeKey: string;
  // The flagged biomarker names that triggered this suggestion (for the "because your
  // … is low/high" rationale). Current, family-collapsed readings only.
  triggeredBy: string[];
  foods: SuggestedFood[];
  evidence: string;
  source: string;
  caveat: string | null;
  // Allergy swaps, medication cautions, and condition annotations gathered during
  // screening. A caution never silently drops a food (except a "drop"-severity
  // condition tag, which withholds the whole suggestion — it never appears).
  safetyNotes: FoodSafetyNote[];
}

// Whether any active condition or situation contains the (lowercased) match term.
function conditionOrSituationHas(
  term: string,
  conditions: string[],
  situations: string[]
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  return [...conditions, ...situations].some((c) =>
    (c ?? "").toLowerCase().includes(needle)
  );
}

// The set of food–drug interaction entry keys the active stack participates in, mapped
// to the strongest hit (for its advice copy). Computed once per call — the INVERSE of
// the per-item food-timing screen ("before recommending food Y, check the stack").
function stackFoodDrugHits(
  medications: SafetyMedication[]
): Map<string, { advice: string; food: string }> {
  const byKey = new Map<string, { advice: string; food: string }>();
  for (const med of medications) {
    for (const hit of matchFoodInteractions({
      name: med.name,
      rxcui: med.rxcui,
      rxcuiIngredients: med.rxcuiIngredients,
    })) {
      if (!byKey.has(hit.key))
        byKey.set(hit.key, { advice: hit.advice, food: hit.food });
    }
  }
  return byKey;
}

// A food survives the allergy screen unless a recorded allergen (direct or cross-
// reactive) strikes its display text. Returns the allergen label when struck.
function allergyStrike(food: FoodSource, allergens: string[]): string | null {
  const hit = allergenConflict(food.food, allergens);
  if (!hit) return null;
  return hit.viaCrossReactivity
    ? `${hit.allergen} (via ${hit.viaCrossReactivity})`
    : hit.allergen;
}

// Build one suggestion for a triggered nutrient entry, running the three safety
// screens. Returns null when the suggestion is withheld entirely (a drop-severity
// condition tag, or every food struck by an allergy with no viable alternative).
function buildSuggestion(
  entry: NutrientFoodEntry,
  triggeredBy: string[],
  input: FoodSuggestInput,
  drugHits: Map<string, { advice: string; food: string }>,
  flaggedHigh: Set<string>
): FoodSuggestion | null {
  const notes: FoodSafetyNote[] = [];

  // 1. Condition/situation contraindications. A "drop" hit withholds the whole
  //    suggestion (increasing the nutrient is hazardous for the condition).
  for (const c of entry.contraindications) {
    if (conditionOrSituationHas(c.match, input.conditions, input.situations)) {
      if ((c.severity ?? "caution") === "drop") return null;
      notes.push({ kind: "condition", text: c.caution });
    }
  }

  // 2. Allergy screen over the primary foods. A struck primary food drops out; if ALL
  //    primaries are struck, fall back to the entry's alternative (itself screened).
  const survivingPrimaries: SuggestedFood[] = [];
  const struckLabels = new Set<string>();
  for (const f of entry.foods) {
    const struck = allergyStrike(f, input.allergens);
    if (struck) {
      struckLabels.add(struck);
      continue;
    }
    survivingPrimaries.push({
      food: f.food,
      foodGroup: f.foodGroup,
      serving: f.serving,
      isAlternative: false,
    });
  }

  let foods: SuggestedFood[] = survivingPrimaries;
  if (survivingPrimaries.length === 0) {
    // Every primary struck — try the alternative.
    const alt = entry.allergyAlternative;
    if (!alt || allergyStrike(alt, input.allergens)) return null; // nothing safe to offer
    foods = [
      {
        food: alt.food,
        foodGroup: alt.foodGroup,
        serving: alt.serving,
        isAlternative: true,
      },
    ];
    notes.push({
      kind: "allergy",
      text: `Your ${[...struckLabels].join(", ")} allergy rules out the usual sources — here is an alternative.`,
    });
  } else if (struckLabels.size > 0) {
    notes.push({
      kind: "allergy",
      text: `Some sources were left out for your ${[...struckLabels].join(", ")} allergy.`,
    });
  }

  // 3. Medication screen (food–drug inverse). Attach the advice for any interaction
  //    entry a surviving food participates in AND the stack matches. Deduped by key.
  const seenDrugKeys = new Set<string>();
  for (const f of entry.foods) {
    for (const dk of f.foodDrugKeys ?? []) {
      if (seenDrugKeys.has(dk)) continue;
      const hit = drugHits.get(dk);
      if (hit) {
        seenDrugKeys.add(dk);
        notes.push({ kind: "medication", text: hit.advice });
      }
    }
  }

  // 4. Excess-caution screen (issue #775). A biomarker-driven caution TEMPERS this add
  //    suggestion when a related toxin/marker reads high — the mercury→fatty-fish case,
  //    generalizing the static pregnancy caution. It never withholds the suggestion
  //    (fish is still the omega-3 answer), only qualifies which species.
  if (entry.excessCaution) {
    const hit = entry.excessCaution.biomarkers.some((b) =>
      flaggedHigh.has(b.trim().toLowerCase())
    );
    if (hit) notes.push({ kind: "biomarker", text: entry.excessCaution.note });
  }

  return {
    key: entry.key,
    label: entry.label,
    direction: "add",
    dedupeKey: foodSuggestSignalKey(entry.key),
    triggeredBy,
    foods,
    evidence: entry.evidence,
    source: entry.source,
    caveat: entry.caveat,
    safetyNotes: notes,
  };
}

// Build one high-side REDUCE suggestion (issue #775) — the deliberate other direction of
// the ONE engine. Reduce entries carry only "limit"-tier foods to eat LESS of, so the
// allergy/contraindication ADD-screens don't apply (you can't be "allergic" to a food
// you're told to avoid, and there's no nutrient to over-supply): the foods surface as-is
// with their evidence/caveat, under the separate `food-reduce:` dedupe namespace. Never
// null — a reduce suggestion is always safe to show.
function buildReduceSuggestion(
  entry: ReduceFoodEntry,
  triggeredBy: string[]
): FoodSuggestion {
  return {
    key: entry.key,
    label: entry.label,
    direction: "reduce",
    dedupeKey: foodReduceSignalKey(entry.key),
    triggeredBy,
    foods: entry.foods.map((f) => ({
      food: f.food,
      foodGroup: f.foodGroup,
      serving: f.serving,
      isAlternative: false,
    })),
    evidence: entry.evidence,
    source: entry.source,
    caveat: entry.caveat,
    safetyNotes: [],
  };
}

// The pure engine: currently-flagged readings + profile safety context → safety-
// screened food suggestions, in the curated map's order. Deterministic; no DB/clock.
export function suggestFoods(input: FoodSuggestInput): FoodSuggestion[] {
  // Index flagged readings by lowercased name for O(1) family lookup, split by side.
  const flaggedLow = new Map<string, string>(); // lower(name) -> original name
  const flaggedHighNames = new Map<string, string>();
  for (const r of input.flagged) {
    const lower = r.name.trim().toLowerCase();
    if (isLowFlag(r.flag)) flaggedLow.set(lower, r.name);
    else if (isHighFlag(r.flag)) flaggedHighNames.set(lower, r.name);
  }
  if (flaggedLow.size === 0 && flaggedHighNames.size === 0) return [];

  const flaggedHigh = new Set(flaggedHighNames.keys());
  const drugHits = stackFoodDrugHits(input.medications);
  const out: FoodSuggestion[] = [];

  // Low side (ADD): a flagged-low nutrient → the curated food sources, safety-screened.
  for (const entry of ENTRIES) {
    const triggeredBy: string[] = [];
    for (const bm of entry.biomarkers) {
      const original = flaggedLow.get(bm.trim().toLowerCase());
      if (original) triggeredBy.push(original);
    }
    if (triggeredBy.length === 0) continue;
    const suggestion = buildSuggestion(
      entry,
      triggeredBy,
      input,
      drugHits,
      flaggedHigh
    );
    if (suggestion) out.push(suggestion);
  }

  // High side (REDUCE, #775): a flagged-high core-panel biomarker → the limit-tier foods
  // to eat less of. Appended after the add suggestions, in curated reduce-table order.
  for (const entry of REDUCE_ENTRIES) {
    const triggeredBy: string[] = [];
    for (const bm of entry.biomarkers) {
      const original = flaggedHighNames.get(bm.trim().toLowerCase());
      if (original) triggeredBy.push(original);
    }
    if (triggeredBy.length === 0) continue;
    out.push(buildReduceSuggestion(entry, triggeredBy));
  }

  return out;
}

// Map a lib/dri.ts nutrient key (dri.json uses snake_case: `vitamin_d`) to the
// nutrient-food-map entry key (hyphenated: `vitamin-d`) where the two datasets name
// the same nutrient. The RDA-adequacy view (#578) uses this to link a below-RDA
// supplement nutrient to its food-first sources from the #577 map — so this covers the
// full DRI↔map overlap (#774), not just the flaggable ones (a nutrient with no blood
// biomarker, like vitamin C, still gets a food-sources line on the adequacy card).
const DRI_KEY_TO_MAP_KEY: Record<string, string> = {
  vitamin_a: "vitamin-a",
  vitamin_c: "vitamin-c",
  vitamin_d: "vitamin-d",
  vitamin_e: "vitamin-e",
  folate: "folate",
  calcium: "calcium",
  magnesium: "magnesium",
  zinc: "zinc",
  iron: "iron",
  selenium: "selenium",
  copper: "copper",
  iodine: "iodine",
  molybdenum: "molybdenum",
};

// The canonical biomarker names (lib/canonical-biomarkers.json) that MEASURE each
// dri.json nutrient — the FLAGGABILITY LEDGER for the #774 coverage reflection guard.
// A DRI nutrient with ≥1 name here is "flaggable" (the app can read it low), so it MUST
// carry a food-map entry (a low flag would otherwise produce no food answer). An EMPTY
// list is a DRI nutrient with no blood biomarker the app flags (vitamin C, B6, niacin,
// boron, manganese) — no low-side suggestion is possible for it, though the RDA-adequacy
// surface can still link food sources by DRI key where a map entry exists. This ledger
// is kept in lockstep with dri.json's keys (the guard test pins that they align), so a
// NEW flaggable DRI nutrient can't silently ship without a food answer.
export const DRI_NUTRIENT_BIOMARKERS: Record<string, string[]> = {
  vitamin_a: ["Vitamin A (Retinol)"],
  vitamin_d: ["Vitamin D, 25-Hydroxy"],
  vitamin_e: [
    "Vitamin E (Alpha-Tocopherol)",
    "Vitamin E (Beta/Gamma-Tocopherol)",
  ],
  vitamin_c: [],
  vitamin_b6: [],
  niacin: [],
  folate: ["Folate", "Folate, RBC"],
  calcium: ["Calcium"],
  magnesium: ["Magnesium", "Magnesium, RBC"],
  zinc: ["Zinc"],
  iron: ["Ferritin", "Iron"],
  selenium: ["Selenium"],
  copper: ["Copper"],
  manganese: [],
  iodine: ["Iodine"],
  molybdenum: ["Molybdenum"],
  boron: [],
};

// The dri.json nutrient keys that CAN be flagged low (a canonical biomarker measures
// them) — the set the #774 coverage guard asserts each resolves to ≥1 food-map entry.
export function flaggableDriNutrients(): string[] {
  return Object.entries(DRI_NUTRIENT_BIOMARKERS)
    .filter(([, names]) => names.length > 0)
    .map(([key]) => key);
}

// The curated food source display names for a dri.json nutrient key, from the #577
// map, or [] when the map has no entry for it. Pure — the RDA adequacy surface formats
// "Food sources: …" over this.
export function foodSourcesForDriNutrient(driKey: string): string[] {
  const mapKey = DRI_KEY_TO_MAP_KEY[driKey];
  if (!mapKey) return [];
  const entry = ENTRIES.find((e) => e.key === mapKey);
  return entry ? entry.foods.map((f) => f.food) : [];
}

// All biomarker names the map references — across the low `entries` (their triggering
// biomarkers + any excess-caution biomarker like mercury) AND the high `reduceEntries`
// (#775) — for the anti-drift dataset test: every one must resolve to a canonical
// biomarker.
export function nutrientFoodMapBiomarkers(): string[] {
  const names = new Set<string>();
  for (const e of ENTRIES) {
    for (const b of e.biomarkers) names.add(b);
    for (const b of e.excessCaution?.biomarkers ?? []) names.add(b);
  }
  for (const e of REDUCE_ENTRIES) for (const b of e.biomarkers) names.add(b);
  return [...names];
}

// All non-null food-group slugs the map references (for the #579 cross-reference test
// once lib/food-groups.json exists — every one must resolve to a food group).
export function nutrientFoodMapGroupSlugs(): string[] {
  const slugs = new Set<string>();
  for (const e of ENTRIES) {
    for (const f of e.foods) if (f.foodGroup) slugs.add(f.foodGroup);
    if (e.allergyAlternative?.foodGroup)
      slugs.add(e.allergyAlternative.foodGroup);
  }
  for (const e of REDUCE_ENTRIES)
    for (const f of e.foods) if (f.foodGroup) slugs.add(f.foodGroup);
  return [...slugs];
}

// All food–drug interaction keys the map references (for the anti-drift test — every
// one must resolve to an entry in lib/datasets/data/food-drug-interactions.json).
export function nutrientFoodMapDrugKeys(): string[] {
  const keys = new Set<string>();
  for (const e of ENTRIES)
    for (const f of e.foods) for (const k of f.foodDrugKeys ?? []) keys.add(k);
  for (const e of REDUCE_ENTRIES)
    for (const f of e.foods) for (const k of f.foodDrugKeys ?? []) keys.add(k);
  return [...keys];
}

export {
  NUTRIENT_FOOD_ENTRIES,
  REDUCE_FOOD_ENTRIES,
} from "./datasets/nutrient-food-map";
