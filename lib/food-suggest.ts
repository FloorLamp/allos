// The DETERMINISTIC biomarker→food suggestion engine (issue #577), the OUTPUT half of
// the nutrition umbrella (#576). When a profile's CURRENT reading for a diet-responsive
// biomarker family is flagged in the direction the curated entry DECLARES (low for the
// classic deficiency route; high for the #2754 add-on-high soluble-fiber route), this
// proposes the curated food sources that address it (lib/nutrient-food-map.json) — each
// suggestion safety-screened against the profile's allergies, medications, and
// conditions/situations BEFORE it renders.
//
// This is the food twin of lib/supplement-suggest.ts, but with a load-bearing
// difference: the suggestions come ONLY from the curated, human-reviewable map — never
// from free AI generation. The engine here is PURE (no DB/network/clock): the DB gather
// lives in lib/queries/nutrition/adequacy.ts (getFoodSuggestions), which both surfaces (the
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
// TWO DOORS INTO ONE ENGINE (issue #2383). A curated entry is selected either by a
// FLAGGED BIOMARKER (the #577 route above) or by a caller naming it DIRECTLY through a
// `TargetTrigger` — the shape a resolved daily target the day's logs fell short of takes
// (protein and fibre, which have no assay here). Everything after selection is identical,
// because everything after selection is about the FOOD: the same allergy screen, the same
// food–drug inverse, the same contraindications, the same preference filter, the same
// dedupe namespaces. See TargetTrigger below.
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
  ReduceFoodEntry,
  FoodSource,
} from "@/scripts/gen-nutrient-food-map";
import {
  NUTRIENT_FOOD_ENTRIES,
  REDUCE_FOOD_ENTRIES,
  type NutrientFoodMapEntry,
} from "./datasets/nutrient-food-map";
import { allergenConflict, type SafetyMedication } from "./supplement-safety";
import type { ConditionInput } from "./condition-codes";
import { stackFoodDrugHits } from "./food-drug-interactions";
import { applyPreferenceFilter, isExcludedGroup } from "./dietary-preferences";
import { joinNamesForSentence } from "./summarize-names";
import {
  suggestCurated,
  type FlaggedReading,
  type TargetTrigger,
} from "./curated-suggest";

const ENTRIES: NutrientFoodMapEntry[] = NUTRIENT_FOOD_ENTRIES;
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

// THE FLAG SORT, THE SECOND DOOR AND THE READING SHAPE now live in the shared engine
// (lib/curated-suggest.ts, #5173) because both curated engines always asked them
// identically. Re-exported here so `@/lib/food-suggest` stays the import site it has
// been since #577.
export {
  isLowFlag,
  isHighFlag,
  type FlaggedReading,
  type TargetTrigger,
} from "./curated-suggest";

export interface FoodSuggestInput {
  // Currently-flagged biomarker readings (family-collapsed, current-only per #557).
  flagged: FlaggedReading[];
  // Curated entries named directly by a caller that already resolved its own shortfall
  // (#2383) — see TargetTrigger. Omitted/[] = the biomarker route only.
  targets?: readonly TargetTrigger[];
  // Recorded allergen substances (getAllergies(...).map(a => a.substance)).
  allergens: string[];
  // The active stack's medications, for the food–drug inverse screen.
  medications: SafetyMedication[];
  // Active conditions (the shared safety-context gather) — bare names or coded
  // refs, so the contraindication screen is code-first (#1030).
  conditions: ConditionInput[];
  // Active situation names (getActiveSituations(...)).
  situations: string[];
  // Excluded food-group slugs (issue #975 — dietary preferences). A SOFTER layer than the
  // safety screens above: it FILTERS + SUBSTITUTES the surfaced foods (a vegetarian's zinc
  // suggestion leads with legumes, not oysters) but NEVER withholds a whole suggestion — a
  // shortfall must never disappear because its top source was excluded. Omitted/[] = no
  // preferences.
  excludedGroups?: string[];
}

export type FoodSafetyNoteKind =
  | "allergy"
  | "medication"
  | "condition"
  // A biomarker-driven excess caution (issue #775) — e.g. an elevated mercury
  // tempering the fatty-fish suggestion. Rendered like a condition caution.
  | "biomarker"
  // A dietary-preference substitution (issue #975) — the excluded top sources were
  // left out and preference-friendly ones lead. Informational, never a safety note.
  | "preference";

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
  // format the framing off this (eat more vs eat less, low vs high).
  direction: "add" | "reduce";
  // `food-suggest:<key>` (add) or `food-reduce:<key>` (reduce) — the findings-bus
  // dedupeKey (family-keyed, #482; separate namespaces so the two can't collide).
  dedupeKey: string;
  // Which flag SIDE triggered it — the entry's declared trigger direction, NOT the
  // verb. The classic add routes are low-triggered and every reduce route is
  // high-triggered, but the #2754 add-on-high entry (soluble fiber for LDL/ApoB) is
  // an ADD triggered by a HIGH flag — copy that derives "is low"/"is high" from the
  // verb would lie about it, so the trigger side rides along explicitly.
  side: "low" | "high";
  // The flagged biomarker names that triggered this suggestion (for the concise
  // "Vitamin D is LOW" rationale). Current, family-collapsed readings only.
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

/**
 * The suggestion card's headline sentence: "LDL Cholesterol and ApoB are high —
 * eat more:".
 *
 * It lives here, beside the type, because the string a card leads with is the
 * suggestion's own claim and both surfaces that render suggestions have to make it
 * identically. It is also the only tier that can TEST it (#3446).
 *
 * TWO THINGS THE PHONE REVIEW FOUND WRONG WITH THE OLD TEMPLATE (#3497 item 3):
 *
 * 1. It joined the trigger names with ", " — the same ambiguity `summarizeNames`
 *    carried (#3496), at a second site. "LDL Cholesterol, Apolipoprotein B (ApoB)"
 *    reads as two names only if you already know the second one; a lab name with a
 *    comma in it reads as three. The names now go through the shared
 *    `joinNamesForSentence`.
 * 2. It shouted the side word — "are HIGH." — on a card whose amber/green tone
 *    already carries the verdict. Caps are the loudest channel this app has and it
 *    was spending them on the thing the reader can see. Sentence case.
 *
 * THE SIDE WORD IS STILL THE DECLARED TRIGGER (#2754), NOT THE VERB. The
 * soluble-fiber entry is an ADD that fires on a HIGH flag, so "eat more" and "is
 * high" both being true in one sentence is correct and load-bearing. Nothing here
 * derives one from the other.
 *
 * The names are NOT re-cased. A stored clinical name is the record ("LDL
 * Cholesterol"), and a display casing pass over clinical names is the thing
 * docs/internals/copy.md §9 rules out — an imported name is cleaned at the import
 * boundary with the person confirming, never here.
 */
export function foodSuggestionHeadline(
  suggestion: Pick<
    FoodSuggestion,
    "triggeredBy" | "label" | "side" | "direction"
  >
): string {
  const reasons =
    suggestion.triggeredBy.length > 0
      ? suggestion.triggeredBy
      : [suggestion.label];
  const verb = reasons.length > 1 ? "are" : "is";
  const eat = suggestion.direction === "reduce" ? "eat less" : "eat more";
  return `${joinNamesForSentence(reasons)} ${verb} ${suggestion.side} — ${eat}:`;
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
    side: "high",
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

/**
 * The pure engine, as a DECLARATION over the shared curated-suggestion engine
 * (lib/curated-suggest.ts, #5173): currently-flagged readings and/or directly-named
 * targets + profile safety context → safety-screened food suggestions, in the curated
 * map's order. Deterministic; no DB, no clock.
 *
 * WHAT THIS DECLARES that the supplement twin does not: `extraTriggers` (the #2383
 * second door), `reduceEntries` (the #775 high side) and `exclude` (the #975 soft
 * dietary-preference layer). What it does NOT declare — `alreadyTaking` — is the
 * supplement side's, and its absence is exactly the behaviour this engine had before
 * the two loops became one.
 */
export function suggestFoods(input: FoodSuggestInput): FoodSuggestion[] {
  // The food–drug inverse index, built on FIRST USE: nothing flagged, no index.
  let drugHits: Map<string, { advice: string; food: string }> | null = null;
  // Dietary preferences (#975) — the excluded food-group set the ADD suggestions filter
  // and substitute against. REDUCE suggestions (limit-tier foods to eat LESS of) are
  // left untouched: excluding a food you're already told to cut back on is moot.
  const excluded = new Set(input.excludedGroups ?? []);

  return suggestCurated<
    NutrientFoodMapEntry,
    FoodSource,
    FoodSuggestion,
    FoodSafetyNote,
    ReduceFoodEntry
  >(input.flagged, {
    entries: ENTRIES,
    extraTriggers: input.targets,
    reduceEntries: REDUCE_ENTRIES,
    buildReduce: buildReduceSuggestion,
    conditions: input.conditions,
    situations: input.situations,
    // A food survives unless a recorded allergen (direct or cross-reactive) strikes its
    // display text; the label is what the swap copy names.
    screenItem: (f) => {
      const label = allergyStrike(f, input.allergens);
      return label ? { field: "allergen", label } : null;
    },
    struckNote: (strikes, allStruck) => {
      if (!allStruck && strikes.length === 0) return null;
      const labels = [...new Set(strikes.map((x) => x.label ?? ""))].join(", ");
      return allStruck
        ? {
            kind: "allergy",
            text: `Your ${labels} allergy rules out the usual sources — here is an alternative.`,
          }
        : {
            kind: "allergy",
            text: `Some sources were left out for your ${labels} allergy.`,
          };
    },
    // Read off the entry's WHOLE source list, not just the survivors: a warfarin
    // profile's leafy-greens advice is about the nutrient, not about which serving
    // happened to survive the allergy screen.
    drugKeys: (f) => f.foodDrugKeys,
    drugNoteScope: "entry",
    drugAdvice: (key) =>
      (drugHits ??= stackFoodDrugHits(input.medications)).get(key)?.advice ??
      null,
    note: (kind, text) => ({ kind, text }),
    // The excess-caution screen (#775). A biomarker-driven caution TEMPERS this add
    // suggestion when a related toxin/marker reads high — the mercury→fatty-fish case.
    // It never withholds the suggestion (fish is still the omega-3 answer), only
    // qualifies which species.
    extraNotes: (entry, flags) => {
      const caution = entry.excessCaution;
      if (!caution) return [];
      const hit = caution.biomarkers.some((b) =>
        flags.high.has(b.trim().toLowerCase())
      );
      return hit ? [{ kind: "biomarker", text: caution.note }] : [];
    },
    exclude:
      excluded.size > 0
        ? {
            isExcluded: (f) => isExcludedGroup(f.foodGroup, excluded),
            filteredNote: {
              kind: "preference",
              text: "Sources you don't eat were left out — these fit your dietary preferences.",
            },
            alternativeNote: {
              kind: "preference",
              text: "The usual sources don't fit your dietary preferences — here's a preference-friendly alternative.",
            },
          }
        : undefined,
    finish: (entry, triggeredBy, rendered, notes) => ({
      key: entry.key,
      label: entry.label,
      direction: "add",
      dedupeKey: foodSuggestSignalKey(entry.key),
      side: entry.direction,
      triggeredBy,
      foods: rendered.map((r) => ({
        food: r.item.food,
        foodGroup: r.item.foodGroup,
        serving: r.item.serving,
        isAlternative: r.isAlternative,
      })),
      evidence: entry.evidence,
      source: entry.source,
      caveat: entry.caveat,
      safetyNotes: notes,
    }),
  });
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

// The canonical biomarker names (lib/canonical-result-definitions.json) that MEASURE each
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
// "Food sources: …" over this. When `excludedGroups` is passed (issue #975 — dietary
// preferences), the excluded groups are filtered/substituted the same way as the #577
// suggestions: preference-compatible sources lead, and if EVERY source is excluded they're
// kept (a food answer never disappears entirely).
export function foodSourcesForDriNutrient(
  driKey: string,
  excludedGroups?: readonly string[]
): string[] {
  const mapKey = DRI_KEY_TO_MAP_KEY[driKey];
  if (!mapKey) return [];
  const entry = ENTRIES.find((e) => e.key === mapKey);
  if (!entry) return [];
  const excluded = new Set(excludedGroups ?? []);
  return applyPreferenceFilter(entry.foods, excluded).map((f) => f.food);
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
