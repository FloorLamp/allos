// The DETERMINISTIC biomarker→supplement suggestion engine (issue #2378) — the twin of
// the biomarker→food engine (lib/food-suggest.ts, #577), built to the same contract.
//
// When a profile's CURRENT reading for a covered biomarker family is flagged in the
// direction the entry DECLARES (low for the repletion routes; high for the #2754
// `lipids` soluble-fiber entry), this proposes the curated supplement that answers it
// (lib/datasets/data/biomarker-supplement-map.json) — safety-screened against the
// profile's allergies, medications, and conditions/situations BEFORE it renders.
//
// The load-bearing property, exactly as on the food side: the suggestions come ONLY
// from the curated, human-reviewable map — never from free AI generation. The engine is
// PURE (no DB/network/clock/model), so a covered family yields byte-identical output on
// every run; the DB gather lives in lib/queries/nutrition/adequacy.ts
// (getCuratedSupplementSuggestions), which every surface formats — "one question, one
// computation."
//
// THE AI ROUTE IS NOT GONE, IT IS THE FALLBACK. lib/supplement-suggest.ts still answers
// what this map does not cover, and the two are visibly distinguished where they render
// (`origin: "curated"` here; the AI drafts land in intake_item_suggestions and render
// with a generated badge). A curated recommendation and a generated one are different
// claims and must not look the same.
//
// SAFETY — every screen here is an EXISTING one, reused:
//   • Allergen (direct + cross-reactive), medication interaction, and condition→nutrient
//     all run through screenSuggestionSafety (lib/supplement-safety.ts) — the same
//     deterministic belt that post-validates the AI route's output. A struck primary
//     falls back to the entry's curated alternative (itself screened); if nothing safe
//     remains, the whole suggestion is WITHHELD. Absence is never an all-clear.
//   • Condition/situation tags declared by the map go through
//     conditionOrSituationMatches (lib/condition-nutrient) — the same matcher the food
//     engine uses, code-first per #1030.
//   • Medication TIMING notes come from the food–drug inverse index
//     (stackFoodDrugHits, lib/food-drug-interactions) — the same index, the same advice
//     copy the food engine attaches.
//   • "Already in your stack" uses the shared substance tokenizer (tokenContains).
//
// Framing is informational, never prescriptive, and NO suggestion carries a dose — the
// map does not contain one to carry.

import type {
  BiomarkerSupplementMapEntry,
  SupplementSource,
} from "./datasets/biomarker-supplement-map";
import { BIOMARKER_SUPPLEMENT_ENTRIES } from "./datasets/biomarker-supplement-map";
import {
  screenSuggestionSafety,
  type SafetyContext,
  type SafetyMedication,
} from "./supplement-safety";
import { stackFoodDrugHits } from "./food-drug-interactions";
import type { ConditionInput } from "./condition-codes";
import {
  isLowFlag,
  isHighFlag,
  suggestCurated,
  type FlaggedReading,
} from "./curated-suggest";
import type { FoodTiming } from "./types";

const ENTRIES: BiomarkerSupplementMapEntry[] = BIOMARKER_SUPPLEMENT_ENTRIES;

// The covered biomarker set, built ONCE at module load — the map is a frozen committed
// dataset, so there is nothing to rebuild per call. Lowercased name → display spelling,
// which is the spelling the gather compares against (see curatedSupplementBiomarkers).
const COVERED_NAMES = new Map<string, string>(
  ENTRIES.flatMap((e) =>
    e.biomarkers.map((b) => [b.trim().toLowerCase(), b] as const)
  )
);

export interface CuratedSupplementInput {
  // Currently-flagged biomarker readings (family-collapsed, current-only per #557).
  //
  // WHICH SPELLING ARRIVES HERE, because the next entry's author will otherwise guess:
  // getCurrentFlaggedBiomarkers emits
  // `COALESCE(NULLIF(TRIM(canonical_name), ''), name)` — the reading's CANONICAL name
  // when it has been reconciled to one, else the raw document name. So a map entry's
  // `biomarkers` must be spelled exactly as lib/canonical-result-definitions.json spells it
  // ("Ferritin", not "Ferritin, Serum"; "Vitamin D, 25-Hydroxy", not "Vitamin D"). The
  // dataset test enforces that every referenced name resolves there, so a wrong guess
  // fails CI rather than silently never matching.
  flagged: FlaggedReading[];
  // Recorded allergen substances. The ingestible-conservative set (resolved allergies
  // included, #691) — see getIngestibleSafetyContext.
  allergens: string[];
  // The active stack's medications, for the interaction screen + the timing notes.
  medications: SafetyMedication[];
  // Active conditions — bare names or coded refs, so the screens are code-first (#1030).
  conditions: ConditionInput[];
  // Active situation names (getActiveSituations).
  situations: string[];
  // Names of the intake items the profile already takes (active supplements AND
  // medications — they share intake_items and either can already supply the substance).
  // A covered family the profile is already supplementing yields NO suggestion: telling
  // someone to start what they are already taking is noise, not a recommendation.
  alreadyTaking?: string[];
}

export type SupplementSafetyNoteKind =
  // A primary was struck by an allergy and the curated alternative surfaced instead.
  | "allergy"
  // A stack medication's curated timing advice (the food–drug inverse index).
  | "medication"
  // An active condition/situation caution declared by the map.
  | "condition";

export interface SupplementSafetyNote {
  kind: SupplementSafetyNoteKind;
  text: string;
}

export interface SuggestedSupplement {
  name: string;
  // How to take it relative to food, in the schedule's own vocabulary.
  foodTiming: FoodTiming;
  // Dose-free practical note, or null.
  note: string | null;
  // True when this is the curated ALTERNATIVE, surfaced because every primary was
  // struck by a safety screen.
  isAlternative: boolean;
}

export interface CuratedSupplementSuggestion {
  // The map entry key — the suggestion's identity (one per family, #482).
  key: string;
  label: string;
  // WHERE THIS CAME FROM. Always "curated" here; it is on the record so a surface
  // cannot render a curated claim and a generated one identically by accident.
  origin: "curated";
  // Which flag SIDE triggered it — the entry's declared direction (#2754). The lipids
  // entry is high-triggered, so the "is LOW"/"is HIGH" copy reads this, never a default.
  side: "low" | "high";
  // The flagged biomarker names that triggered it (the "Vitamin D is LOW" rationale).
  triggeredBy: string[];
  supplements: SuggestedSupplement[];
  evidence: string;
  source: string;
  caveat: string | null;
  // Allergy swaps, medication timing notes, and condition annotations gathered during
  // screening. A note never silently drops a supplement; a hard screen withholds the
  // whole suggestion instead (it simply never appears).
  safetyNotes: SupplementSafetyNote[];
}

// A supplement candidate, screened by the SHARED belt. Returns the drop reason or null.
function screen(candidate: SupplementSource, ctx: SafetyContext) {
  return screenSuggestionSafety({ name: candidate.name }, ctx);
}

// Human copy for why the primaries were struck and the alternative is showing instead.
function struckNote(field: "allergen" | "interaction" | "condition"): string {
  if (field === "allergen")
    return "Your recorded allergy rules out the usual form — here is an alternative.";
  if (field === "interaction")
    return "The usual form interacts with one of your medications — here is an alternative.";
  return "The usual form isn't advised with one of your recorded conditions — here is an alternative.";
}

function toSuggested(
  s: SupplementSource,
  isAlternative: boolean
): SuggestedSupplement {
  return {
    name: s.name,
    foodTiming: s.foodTiming,
    note: s.note,
    isAlternative,
  };
}

/**
 * The pure engine, as a DECLARATION over the shared curated-suggestion engine
 * (lib/curated-suggest.ts, #5173): currently-flagged readings + profile safety context →
 * safety-screened supplement suggestions, in the curated map's order. Deterministic; no
 * DB, no clock, no model. The same input always yields the same output.
 *
 * WHAT THIS DECLARES that the food twin does not: `alreadyTaking` (a covered family the
 * profile already supplements yields NO suggestion) and the shared deterministic belt as
 * its per-candidate screen. What it does NOT declare — target triggers, reduce entries,
 * the dietary-preference layer — is the food side's, and its absence is exactly the
 * behaviour this engine had before the two loops became one.
 */
export function suggestCuratedSupplements(
  input: CuratedSupplementInput
): CuratedSupplementSuggestion[] {
  // The belt's facts, in the shape screenSuggestionSafety consumes — assembled once.
  const safety: SafetyContext = {
    allergens: input.allergens,
    medications: input.medications,
    conditions: input.conditions,
  };
  // The food–drug inverse index, built on FIRST USE: nothing flagged, no index.
  let drugHits: Map<string, { advice: string; food: string }> | null = null;

  return suggestCurated<
    BiomarkerSupplementMapEntry,
    SupplementSource,
    CuratedSupplementSuggestion,
    SupplementSafetyNote
  >(input.flagged, {
    entries: ENTRIES,
    conditions: input.conditions,
    situations: input.situations,
    // Checked over the map's own match tokens (the primaries AND the alternative), so a
    // profile already taking algal oil is not told to start fish oil either.
    alreadyTaking: input.alreadyTaking,
    matchTokens: (s) => s.matchTokens,
    // The SHARED deterministic belt: allergen (direct + cross-reactive), medication
    // interaction, condition→nutrient.
    screenItem: (s) => {
      const drop = screen(s, safety);
      return drop ? { field: drop.field, label: null } : null;
    },
    // Only the all-struck case says anything: a partial strike simply renders the
    // survivors, because a supplement list is a ranked answer, not a menu.
    struckNote: (strikes, allStruck) =>
      allStruck
        ? { kind: "allergy", text: struckNote(strikes[0]?.field ?? "allergen") }
        : null,
    // Read off what is ACTUALLY rendering (the alternative carries its own keys when it
    // stands in), so the notes always describe the substance on screen.
    drugKeys: (s) => s.interactionKeys,
    drugNoteScope: "rendered",
    drugAdvice: (key) =>
      (drugHits ??= stackFoodDrugHits(input.medications)).get(key)?.advice ??
      null,
    note: (kind, text) => ({ kind, text }),
    finish: (entry, triggeredBy, rendered, notes) => ({
      key: entry.key,
      label: entry.label,
      origin: "curated",
      side: entry.direction,
      triggeredBy,
      supplements: rendered.map((r) => toSuggested(r.item, r.isAlternative)),
      evidence: entry.evidence,
      source: entry.source,
      caveat: entry.caveat,
      safetyNotes: notes,
    }),
  });
}

// Every canonical biomarker name the curated map covers, lowercased. THE coverage
// question: a flagged family in this set is answered deterministically, and one outside
// it falls through to the AI route (lib/supplement-suggest.ts). Both the AI prompt (so
// it doesn't duplicate a curated answer) and the anti-drift dataset test read it.
export function curatedSupplementBiomarkers(): string[] {
  return [...COVERED_NAMES.values()];
}

// Whether the curated map answers a given canonical biomarker name (case-insensitive).
export function isCuratedSupplementBiomarker(name: string): boolean {
  const needle = (name ?? "").trim().toLowerCase();
  if (!needle) return false;
  return COVERED_NAMES.has(needle);
}

// name (lowercased) → the trigger SIDES its entries declare. Coverage became per-side
// with #2754: the lipids entry answers LDL/ApoB only when they read HIGH, so "does the
// curated map cover this name" and "does it answer THIS reading" are different
// questions once direction is a per-entry axis.
const COVERED_SIDES = new Map<string, Set<"low" | "high">>();
for (const e of ENTRIES) {
  for (const b of e.biomarkers) {
    const key = b.trim().toLowerCase();
    const sides = COVERED_SIDES.get(key) ?? new Set<"low" | "high">();
    sides.add(e.direction);
    COVERED_SIDES.set(key, sides);
  }
}

// Whether the curated map answers THIS READING — name AND flag side. The AI route's
// "already answered, do not duplicate" muzzle must ask this rather than the name-only
// question above: muzzling a reading the curated engine will not answer (a LOW LDL,
// a HIGH ferritin) would leave that family with no answer from either engine.
export function curatedSupplementAnswersReading(
  name: string,
  flag: string | null | undefined
): boolean {
  const sides = COVERED_SIDES.get((name ?? "").trim().toLowerCase());
  if (!sides) return false;
  if (isLowFlag(flag)) return sides.has("low");
  if (isHighFlag(flag)) return sides.has("high");
  return false;
}

export { BIOMARKER_SUPPLEMENT_ENTRIES } from "./datasets/biomarker-supplement-map";
