// Pure, deterministic SAFETY guard for AI supplement suggestions (issue #413).
//
// supplement-suggest.ts is the one AI feature that proposes INGESTING things, so
// it is the one whose output most needs a clinical-safety net. Its prompt now
// carries the profile's allergies, conditions, and CURRENT medications (fenced as
// untrusted extracted data), but a prompt is a request, not a guarantee — a model
// can still surface fish oil to a fish-allergic user or high-dose vitamin K to
// someone on warfarin. This module is the deterministic BELT the pipeline runs
// over the model's output regardless of what it claimed: a suggestion that matches
// a recorded allergen (directly or by well-documented cross-reactivity), or that
// carries an ingredient with a known high-risk interaction with a current
// medication, is DROPPED server-side. It mirrors the existing "distrust the model"
// post-validation (the mandatory-downgrade in supplement-suggest.ts) — belt over
// the prompt's braces.
//
// Pure (no DB/network): the caller gathers the profile's allergens + medications
// once (one gather feeding BOTH the prompt and this guard) and hands typed arrays
// here. It reuses the committed curated datasets — the #153 allergen
// cross-reactivity families and the #154 food–drug interaction table — so the
// facts live in one place, not a second hand-rolled list.

import { findCrossReactivity } from "./allergen-cross-reactivity";
import { matchFoodInteractions } from "./food-drug-interactions";
import {
  CONDITION_NUTRIENT_RULES,
  conditionMatchesTerm,
} from "./condition-nutrient";
import { conditionInputName, type ConditionInput } from "./condition-codes";

// Normalize a phrase to comparable token form: lowercased, apostrophes dropped,
// any non-alphanumeric run collapsed to a single space, trimmed. Mirrors the
// cross-reactivity / food-drug normalizers so committed data lines up with a live
// suggestion name identically.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Naive singular form (trailing "s" dropped for words > 3 chars), so "eggs"
// matches "egg" and "nuts" matches "nut" without touching short words.
function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}

function tokenize(s: string): string {
  return normalize(s).split(" ").map(singular).join(" ");
}

// Whether `needle` appears as a CONTIGUOUS token subsequence of `haystack` — a
// word-boundary containment so "fish" hits "fish oil" but "egg" never hits inside
// "eggplant". Both sides are singularized token-wise first.
function tokenContains(haystack: string, needle: string): boolean {
  const n = tokenize(needle);
  if (!n) return false;
  return ` ${tokenize(haystack)} `.includes(` ${n} `);
}

// A recorded allergy a supplement suggestion conflicts with.
export interface AllergenHit {
  // The recorded substance that conflicts (display form).
  allergen: string;
  // The cross-reactive family member the suggestion carried, when the match was
  // INDIRECT (via the #153 dataset) rather than a direct substance match.
  viaCrossReactivity?: string;
}

// The recorded allergen a supplement suggestion conflicts with, or null when it's
// clear. `text` is the suggestion's searchable text (name + brand + product).
//   - Direct: the allergen substance appears as a token subsequence of the text,
//     so a "fish" allergy drops "Fish Oil" and a "tree nut" allergy drops
//     "Tree Nut Complex".
//   - Cross-reactivity: the text carries a family member the recorded allergen
//     commonly cross-reacts with (e.g. a shrimp allergy dropping a "Krill Oil"
//     suggestion), reusing the curated #153 matcher. Conservative for an
//     ingestible — cross-reactivity is informational, but we'd rather not propose
//     it at all than propose it to an allergic user.
export function allergenConflict(
  text: string,
  allergens: readonly string[]
): AllergenHit | null {
  const clean = allergens.map((a) => (a ?? "").trim()).filter(Boolean);
  for (const allergen of clean) {
    if (tokenContains(text, allergen)) return { allergen };
  }
  for (const match of findCrossReactivity(clean)) {
    for (const related of match.related) {
      if (tokenContains(text, related)) {
        return {
          allergen: match.triggers.join(", "),
          viaCrossReactivity: related,
        };
      }
    }
  }
  return null;
}

// Supplement/ingredient tokens a food–drug interaction entry warns about, keyed by
// the entry id in food-drug-interactions.json. That dataset's `food` field is human
// prose ("Vitamin K–rich foods (leafy greens)"), so for a DETERMINISTIC drop we map
// the CONTRAINDICATION-flavored entries to the concrete supplement ingredient names
// a suggestion might carry. Deliberately narrow: only entries where ADDING the
// supplement is itself high-risk (vitamin K raising clotting on warfarin; extra
// potassium risking hyperkalemia on an ACE/ARB or potassium-sparing diuretic).
// Timing-only entries (calcium/iron × levothyroxine or an antibiotic — take them
// hours apart, don't avoid) are left to the prompt guardrail, not a hard drop.
const INTERACTION_INGREDIENTS: Record<string, string[]> = {
  "vitamin-k-warfarin": [
    "vitamin k",
    "vitamin k1",
    "vitamin k2",
    "phytonadione",
    "phylloquinone",
    "menaquinone",
  ],
  "potassium-ace-arb": ["potassium"],
  "potassium-diuretic": ["potassium"],
};

// A current medication a supplement suggestion has a known high-risk interaction
// with.
export interface InteractionHit {
  // The current medication's own name (display form).
  medication: string;
  // The interaction entry's drug label + food description (for the drop reason).
  drugLabel: string;
  food: string;
}

// A current medication, in the shape matchFoodInteractions consumes.
export interface SafetyMedication {
  // The intake_items id, when the gather knows it (getIntakeSafetyContext sets it).
  // Optional — the food/allergen consumers match on name/rxcui and never need it; the
  // PGx cross-check (lib/pgx.ts, #710) uses it to anchor a finding's dedupeKey to the
  // specific med. Absent for hand-built SafetyMedication arrays that don't carry one.
  id?: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
}

// The current medication a supplement suggestion has a well-documented, high-risk
// interaction with, or null. Reuses the committed food–drug dataset (#154): for
// each medication we compute its interaction entries, keep only the
// contraindication-flavored subset mapped in INTERACTION_INGREDIENTS, and drop the
// suggestion when its name carries one of those ingredient tokens.
export function interactionConflict(
  name: string,
  medications: readonly SafetyMedication[]
): InteractionHit | null {
  for (const med of medications) {
    const hits = matchFoodInteractions({
      name: med.name,
      rxcui: med.rxcui,
      rxcuiIngredients: med.rxcuiIngredients,
    });
    for (const hit of hits) {
      const tokens = INTERACTION_INGREDIENTS[hit.key];
      if (!tokens) continue;
      if (tokens.some((t) => tokenContains(name, t))) {
        return {
          medication: med.name,
          drugLabel: hit.drugLabel,
          food: hit.food,
        };
      }
    }
  }
  return null;
}

// A recorded condition a supplement suggestion is contraindicated for.
export interface ConditionHit {
  // The active condition that contraindicates it (display form).
  condition: string;
  // The nutrient token the suggestion carried that the condition contraindicates.
  nutrient: string;
  // The curated caution copy (from the shared condition→nutrient dataset).
  caution: string;
}

// The recorded condition a supplement suggestion is contraindicated for, or null when
// clear (issue #657). Reuses the SAME curated drop-severity condition→nutrient rules
// the food-suggestion engine hard-drops on (lib/condition-nutrient, derived from
// nutrient-food-map): a CKD condition drops a supplemental "Potassium …" or
// "Magnesium …" suggestion the model may have surfaced despite the prompt's tempering
// rule. Screened over the suggestion NAME (nutrient identity lives there, like the
// medication interaction screen). Conservative for an ingestible — a hard drop, not an
// annotation, since the belt distrusts the model.
export function conditionConflict(
  name: string,
  conditions: readonly ConditionInput[]
): ConditionHit | null {
  if (conditions.length === 0) return null;
  for (const rule of CONDITION_NUTRIENT_RULES) {
    if (!rule.nutrientTokens.some((t) => tokenContains(name, t))) continue;
    for (const c of conditions) {
      // The shared per-rule matcher (#1030): stored code first, name substring
      // fallback — the same test the UL caveat and the food engine run.
      if (conditionMatchesTerm(rule.match, c)) {
        return {
          condition: conditionInputName(c),
          nutrient: rule.nutrientTokens[0],
          caution: rule.caution,
        };
      }
    }
  }
  return null;
}

// The profile's safety facts, gathered once and fed to both the prompt and this
// guard.
export interface SafetyContext {
  // Recorded allergen substances (display form).
  allergens: string[];
  // Current medications (kind === 'medication', active).
  medications: SafetyMedication[];
  // Active conditions — display names, or coded refs carrying the stored
  // code/code_system so the condition screens are code-first (#657/#1030).
  conditions: ConditionInput[];
}

// Why a suggestion was dropped by the safety guard, or null when it passes.
export interface SafetyDrop {
  field: "allergen" | "interaction" | "condition";
  // A short, self-contained reason for the AI log.
  detail: string;
}

// The deterministic post-validation for ONE suggestion: returns the drop reason,
// or null when it's safe to keep. Checks the allergen conflict over the full
// searchable text (name + brand + product) first, then the medication interaction
// over the name. This is the belt run in normalizeDrafts alongside the existing
// mandatory-downgrade — the model's output is never trusted to have respected the
// prompt's safety instructions.
export function screenSuggestionSafety(
  suggestion: { name: string; brand?: string | null; product?: string | null },
  ctx: SafetyContext
): SafetyDrop | null {
  const text = [suggestion.name, suggestion.brand, suggestion.product]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(" ");

  const allergen = allergenConflict(text, ctx.allergens);
  if (allergen) {
    return {
      field: "allergen",
      detail: allergen.viaCrossReactivity
        ? `"${suggestion.name}" dropped — cross-reacts with recorded allergy "${allergen.allergen}"`
        : `"${suggestion.name}" dropped — matches recorded allergy "${allergen.allergen}"`,
    };
  }

  const interaction = interactionConflict(suggestion.name, ctx.medications);
  if (interaction) {
    return {
      field: "interaction",
      detail: `"${suggestion.name}" dropped — interacts with current medication "${interaction.medication}"`,
    };
  }

  const condition = conditionConflict(suggestion.name, ctx.conditions);
  if (condition) {
    return {
      field: "condition",
      detail: `"${suggestion.name}" dropped — not advised with recorded condition "${condition.condition}" (${condition.caution})`,
    };
  }

  return null;
}
