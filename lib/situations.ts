// Pure helpers for "situations" — the lightweight, ephemeral, NON-clinical context
// toggles ("Illness", "Travel", "High stress", "Poor sleep") a situational
// supplement keys on (issue #560). The DB layer (id-keyed `situations` rows +
// intake_items.situation_id) lives in lib/settings/profile-attrs.ts; this module is
// the string discipline + the one-way condition bridge, kept pure/unit-testable.

import { SUGGESTED_SITUATIONS } from "./supplement-schedule";

// The merged situation-OPTION set — the profile's saved vocabulary rows UNION the
// built-in suggestions, NOCASE-deduped (a stored "illness" collapses onto the suggested
// "Illness"), vocabulary first then the remaining suggestions. The ONE helper the
// Supplements-bar chip row, the dashboard check-in "Anything going on?" chips, and (per
// the #1177 `situation-options` migration) the item-form option source all consume, so
// the three surfaces can never disagree about what the situation vocabulary is (#221).
export interface SituationOption {
  name: string;
  // True when this option is a SAVED vocabulary row (vs a suggestion with no row yet):
  // only a real row can carry the #799 illness-type flag / be toggled illness-type.
  inVocabulary: boolean;
  // The #799 illness-type flag for a saved row (always false for a suggestion-only
  // option). An illness-type situation is a symptom-log container; the dashboard chip
  // row EXCLUDES these (the card's illness door owns that lifecycle, #856).
  illnessType: boolean;
}

export function mergedSituationOptions(
  rows: readonly { name: string; illness_type?: number | boolean | null }[]
): SituationOption[] {
  const byKey = new Map<string, SituationOption>();
  for (const r of rows) {
    const key = normalizeSituationName(r.name).toLowerCase();
    if (!byKey.has(key))
      byKey.set(key, {
        name: r.name,
        inVocabulary: true,
        illnessType: !!r.illness_type,
      });
  }
  for (const s of SUGGESTED_SITUATIONS) {
    const key = normalizeSituationName(s).toLowerCase();
    if (!byKey.has(key))
      byKey.set(key, { name: s, inVocabulary: false, illnessType: false });
  }
  return [...byKey.values()];
}

// The NON-clinical subset of the merged options — the dashboard check-in chip row
// (issue #1221 part 6). Excludes every illness-type vocabulary row AND the built-in
// "Illness" suggestion: the check-in's own "Not feeling well?" door + the #856
// episode-coherence machinery own the illness lifecycle (one lifecycle, one door), so
// a chip must never be a second illness entrypoint.
export function nonIllnessSituationOptions(
  rows: readonly { name: string; illness_type?: number | boolean | null }[]
): SituationOption[] {
  return mergedSituationOptions(rows).filter(
    (o) => !o.illnessType && !isBuiltInIllnessSituation(o.name)
  );
}

// The one-line situations-bar activation acknowledgment (issue #662 item 1):
// "3 situational items now active" when a toggle changes the shape of the due dose
// list, else null when nothing situational is currently due. Pure formatter over the
// count from the shared dueness computation (countSituationalDue) — never a second
// count — so the acknowledgment and the list it acknowledges always agree.
export function situationActivationLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} situational ${count === 1 ? "item" : "items"} now active`;
}

// Canonicalize a situation name: trim + collapse internal whitespace. Paired with
// the situations table's `UNIQUE(profile_id, name COLLATE NOCASE)`, this is what
// removes the #203 casing/whitespace fragility — " Poor  Sleep " and "Poor Sleep"
// (and "poor sleep") resolve to one row/vocabulary.
export function normalizeSituationName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// Two names refer to the same situation when they canonicalize equal, case-folded.
export function sameSituation(a: string, b: string): boolean {
  return (
    normalizeSituationName(a).toLowerCase() ===
    normalizeSituationName(b).toLowerCase()
  );
}

// The clinical situations the condition bridge (part 2) can suggest — the ONLY
// overlap between the medical model and situations. Everything else (Travel, High
// stress, Poor sleep) stays a pure, medically-unlinked situation, by design.
export const CLINICAL_SITUATIONS = {
  Illness: [
    "illness",
    "infection",
    "influenza",
    "flu",
    "cold",
    "covid",
    "coronavirus",
    "fever",
    "pneumonia",
    "bronchitis",
    "sinusitis",
    "gastroenteritis",
    "sick",
    "viral",
    "bacterial",
    "sepsis",
  ],
  Injury: [
    "injury",
    "sprain",
    "strain",
    "fracture",
    "tear",
    "torn",
    "dislocation",
    "contusion",
    "laceration",
    "concussion",
    "whiplash",
    "tendinitis",
    "tendonitis",
  ],
} as const;

export type ClinicalSituation = keyof typeof CLINICAL_SITUATIONS;

// The built-in "Illness" situation — the canonical symptom-log container (issue #799).
// It is the situation whose `illness_type` flag DEFAULTS ON: the symptom card and the
// episode derivation key ONLY on illness-type-flagged situations, and this one is
// flagged out of the box. A user-created situation ("Migraine", "Kid sick") opts in via
// the situations-bar toggle instead; Travel/High-stress never become symptom containers.
export const BUILTIN_ILLNESS_SITUATION = "Illness";

// Whether a situation name IS the built-in Illness (case/whitespace-folded), so the
// migration backfill + the create path default its illness_type flag on. Pure.
export function isBuiltInIllnessSituation(name: string): boolean {
  return sameSituation(name, BUILTIN_ILLNESS_SITUATION);
}

// The built-in "Poor sleep" situation (issue #1292) — a DERIVED situation: a situational
// supplement keys on it, but it turns on from last night's sleep vs baseline (the shared
// rough-night computation) OR a manual toggle, never a machine-written `situations` row.
// It already ships as a SUGGESTED_SITUATION; this constant is the name-keyed identity the
// derived-context resolver + coaching gather use (via sameSituation). No illness_type, no
// episodes. The rules + formatters live in lib/derived-situations.ts.
export const BUILTIN_POOR_SLEEP_SITUATION = "Poor sleep";

// The built-in "Injury" situation name — the situation the injury bridge (#838) suggests
// when a profile logs an injury but no "Injury" situation is active. Suggest-only, like
// the condition/symptom bridges: the user confirms, never auto-activated.
export const BUILTIN_INJURY_SITUATION = "Injury";

// Whether a situation name IS the built-in Injury (case/whitespace-folded). Pure.
export function isBuiltInInjurySituation(name: string): boolean {
  return sameSituation(name, BUILTIN_INJURY_SITUATION);
}

// Injury→situation bridge (issue #838) — the #560 "suggest, never auto" discipline applied
// to the injury layer: logging an injury SUGGESTS activating the "Injury" situation so a
// user's situational supplements (a joint-support stack) can key on it. Returns the
// situation name to offer, or null when an Injury situation is already active. Pure.
export function suggestInjuryActivation(
  hasActiveInjurySituation: boolean
): string | null {
  return hasActiveInjurySituation ? null : BUILTIN_INJURY_SITUATION;
}

// Symptom→situation bridge (issue #799) — the REVERSE of the condition bridge above and
// the FoodLogBar/#560 "suggest, never auto" discipline: when a profile logs symptoms but
// no illness-type situation is active, SUGGEST activating the built-in "Illness" so the
// day's symptoms fall inside a derivable episode. Suggest-only; the user confirms.
// Returns the situation name to offer, or null when an illness-type situation is already
// active (the card is already surfaced — the other direction of the bridge).
export function suggestIllnessActivation(
  hasActiveIllnessSituation: boolean
): string | null {
  return hasActiveIllnessSituation ? null : BUILTIN_ILLNESS_SITUATION;
}

// Map one active condition NAME to a matching clinical situation, or null. Word-ish
// substring match on the canonical keyword set (a condition "Influenza A" → Illness,
// "Left ankle sprain" → Injury). Conservative: an unrecognized condition maps to
// nothing rather than guessing.
export function situationForConditionName(
  conditionName: string
): ClinicalSituation | null {
  const n = conditionName.toLowerCase();
  for (const [situation, keywords] of Object.entries(CLINICAL_SITUATIONS)) {
    if (keywords.some((k) => n.includes(k)))
      return situation as ClinicalSituation;
  }
  return null;
}

// The one-way bridge (issue #560 part 2): given the profile's ACTIVE acute condition
// names and the situations already active, SUGGEST the clinical situations an active
// illness/injury implies but that aren't toggled on yet — so a sick user doesn't
// maintain two parallel toggles (log the condition AND flip the situation). One-way
// and suggest-only: it never auto-deactivates, and travel/stress/sleep are untouched.
// Returns canonical situation names, de-duplicated, in a stable order.
export function suggestedSituationsFromConditions(
  activeConditionNames: string[],
  alreadyActive: string[]
): ClinicalSituation[] {
  const activeLower = new Set(
    alreadyActive.map((s) => normalizeSituationName(s).toLowerCase())
  );
  const out: ClinicalSituation[] = [];
  for (const name of activeConditionNames) {
    const s = situationForConditionName(name);
    if (!s) continue;
    if (activeLower.has(s.toLowerCase())) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
