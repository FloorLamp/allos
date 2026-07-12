// Pure helpers for "situations" — the lightweight, ephemeral, NON-clinical context
// toggles ("Illness", "Travel", "High stress", "Poor sleep") a situational
// supplement keys on (issue #560). The DB layer (id-keyed `situations` rows +
// intake_items.situation_id) lives in lib/settings/profile-attrs.ts; this module is
// the string discipline + the one-way condition bridge, kept pure/unit-testable.

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
