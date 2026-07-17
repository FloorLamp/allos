// Pure helpers for "situations" — the lightweight, ephemeral, NON-clinical context
// toggles ("Illness", "Travel", "High stress", "Poor sleep") a situational
// supplement keys on (issue #560). The DB layer (id-keyed `situations` rows +
// intake_items.situation_id) lives in lib/settings/profile-attrs.ts; this module is
// the string discipline + the one-way condition bridge, kept pure/unit-testable.

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
