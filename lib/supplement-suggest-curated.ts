// The DETERMINISTIC biomarker→supplement suggestion engine (issue #2378) — the twin of
// the biomarker→food engine (lib/food-suggest.ts, #577), built to the same contract.
//
// When a profile's CURRENT reading for a covered biomarker family is flagged low, this
// proposes the curated supplement that repletes it
// (lib/datasets/data/biomarker-supplement-map.json) — safety-screened against the
// profile's allergies, medications, and conditions/situations BEFORE it renders.
//
// The load-bearing property, exactly as on the food side: the suggestions come ONLY
// from the curated, human-reviewable map — never from free AI generation. The engine is
// PURE (no DB/network/clock/model), so a covered family yields byte-identical output on
// every run; the DB gather lives in lib/queries/nutrition.ts
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
  BiomarkerSupplementEntry,
  SupplementSource,
} from "./datasets/biomarker-supplement-map";
import { BIOMARKER_SUPPLEMENT_ENTRIES } from "./datasets/biomarker-supplement-map";
import {
  screenSuggestionSafety,
  tokenContains,
  type SafetyContext,
  type SafetyMedication,
} from "./supplement-safety";
import { conditionOrSituationMatches } from "./condition-nutrient";
import { stackFoodDrugHits } from "./food-drug-interactions";
import type { ConditionInput } from "./condition-codes";
import { isLowFlag, type FlaggedReading } from "./food-suggest";
import type { FoodTiming } from "./types";

const ENTRIES: BiomarkerSupplementEntry[] = BIOMARKER_SUPPLEMENT_ENTRIES;

export interface CuratedSupplementInput {
  // Currently-flagged biomarker readings (family-collapsed, current-only per #557).
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

// Build one suggestion for a triggered entry, running the screens. Returns null when
// the suggestion is withheld entirely — a drop-severity condition tag, the substance
// already being in the stack, or every candidate (primaries AND the alternative)
// struck by the shared belt.
function buildSuggestion(
  entry: BiomarkerSupplementEntry,
  triggeredBy: string[],
  input: CuratedSupplementInput,
  safety: SafetyContext,
  drugHits: Map<string, { advice: string; food: string }>,
  taking: readonly string[]
): CuratedSupplementSuggestion | null {
  // 1. Already in the stack. Checked FIRST and over the map's own match tokens (the
  //    primaries AND the alternative), so a profile already taking algal oil is not told
  //    to start fish oil either.
  const candidates = [
    ...entry.supplements,
    ...(entry.allergyAlternative ? [entry.allergyAlternative] : []),
  ];
  for (const c of candidates) {
    for (const token of c.matchTokens) {
      if (taking.some((item) => tokenContains(item, token))) return null;
    }
  }

  const notes: SupplementSafetyNote[] = [];

  // 2. Map-declared condition/situation tags, via the SHARED matcher. A "drop" tag
  //    withholds the whole suggestion; a "caution" tag annotates it.
  for (const c of entry.contraindications) {
    if (
      conditionOrSituationMatches(c.match, input.conditions, input.situations)
    ) {
      if ((c.severity ?? "caution") === "drop") return null;
      notes.push({ kind: "condition", text: c.caution });
    }
  }

  // 3. The SHARED deterministic belt over each primary: allergen (direct +
  //    cross-reactive), medication interaction, condition→nutrient. Survivors render;
  //    if every primary is struck, the curated alternative is screened and surfaced in
  //    its place; if that is struck too, nothing is offered at all.
  const surviving: SuggestedSupplement[] = [];
  let firstDrop: "allergen" | "interaction" | "condition" | null = null;
  for (const s of entry.supplements) {
    const drop = screen(s, safety);
    if (drop) {
      firstDrop ??= drop.field;
      continue;
    }
    surviving.push(toSuggested(s, false));
  }

  let supplements = surviving;
  if (surviving.length === 0) {
    const alt = entry.allergyAlternative;
    if (!alt || screen(alt, safety)) return null; // nothing safe to offer
    supplements = [toSuggested(alt, true)];
    notes.push({ kind: "allergy", text: struckNote(firstDrop ?? "allergen") });
  }

  // 4. Medication TIMING notes from the food–drug inverse index — the same advice copy
  //    the food engine attaches, deduped by entry key. Never a drop (a hard drop is step
  //    3's job); a separation window is guidance, not a contraindication.
  const seen = new Set<string>();
  for (const s of entry.supplements) {
    for (const k of s.interactionKeys ?? []) {
      if (seen.has(k)) continue;
      const hit = drugHits.get(k);
      if (hit) {
        seen.add(k);
        notes.push({ kind: "medication", text: hit.advice });
      }
    }
  }

  return {
    key: entry.key,
    label: entry.label,
    origin: "curated",
    triggeredBy,
    supplements,
    evidence: entry.evidence,
    source: entry.source,
    caveat: entry.caveat,
    safetyNotes: notes,
  };
}

// The pure engine: currently-flagged readings + profile safety context → safety-screened
// supplement suggestions, in the curated map's order. Deterministic; no DB, no clock, no
// model call. The same input always yields the same output.
export function suggestCuratedSupplements(
  input: CuratedSupplementInput
): CuratedSupplementSuggestion[] {
  const flaggedLow = new Map<string, string>(); // lower(name) -> original name
  for (const r of input.flagged) {
    if (isLowFlag(r.flag)) flaggedLow.set(r.name.trim().toLowerCase(), r.name);
  }
  if (flaggedLow.size === 0) return [];

  // The belt's facts, in the shape screenSuggestionSafety consumes — assembled once.
  const safety: SafetyContext = {
    allergens: input.allergens,
    medications: input.medications,
    conditions: input.conditions,
  };
  const drugHits = stackFoodDrugHits(input.medications);
  const taking = (input.alreadyTaking ?? []).filter((n) => n && n.trim());

  const out: CuratedSupplementSuggestion[] = [];
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
      safety,
      drugHits,
      taking
    );
    if (suggestion) out.push(suggestion);
  }
  return out;
}

// Every canonical biomarker name the curated map covers, lowercased. THE coverage
// question: a flagged family in this set is answered deterministically, and one outside
// it falls through to the AI route (lib/supplement-suggest.ts). Both the AI prompt (so
// it doesn't duplicate a curated answer) and the anti-drift dataset test read it.
export function curatedSupplementBiomarkers(): string[] {
  const names = new Set<string>();
  for (const e of ENTRIES) for (const b of e.biomarkers) names.add(b);
  return [...names];
}

// Whether the curated map answers a given canonical biomarker name (case-insensitive).
export function isCuratedSupplementBiomarker(name: string): boolean {
  const needle = (name ?? "").trim().toLowerCase();
  if (!needle) return false;
  return curatedSupplementBiomarkers().some((n) => n.toLowerCase() === needle);
}

export { BIOMARKER_SUPPLEMENT_ENTRIES } from "./datasets/biomarker-supplement-map";
