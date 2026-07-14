// The PURE decision half of the diabetes↔periodontitis coaching observation
// (issue #706, ask 4). Coaching-tier ONLY per the findings two-tier policy (#449):
// it joins collectCoachingFindings, its dedupeKey prefix is registered in
// RULE_FINDING_PREFIXES, and it NEVER notifies and NEVER reaches the non-hideable
// "Needs attention" hero — it's a calm, informational, dismissible FYI, deliberately
// the calm tier while the dental-cadence tightening (#706 ask 1) is the push side.
//
// COPY STAYS OBSERVATIONAL, NOT PRESCRIPTIVE. It states the well-established
// bidirectional link (poor glycemic control worsens periodontitis; periodontitis
// worsens glycemic control) as information and prescribes nothing beyond "worth
// discussing with your dentist/clinician".
//
// Pure (no DB/clock); the DB input assembly lives in buildOralHealthFindings
// (lib/rule-findings.ts), which reuses the ONE diabetes-detection engine
// (deriveRiskFactors) so this observation and the dental-cadence tightening key on
// the same "has diabetes" answer (one question, one computation).

// dedupeKey namespace for the suppression bus + the RULE_FINDING_PREFIXES registry.
export const ORAL_HEALTH_PREFIX = "oral-health:";

// Stable identity for the periodontitis↔diabetes note. Topic-keyed (not episodic):
// the link holds as long as diabetes is active, so a single dismissal silences it
// until the condition resolves (which drops the finding entirely).
export function periodontalObservationKey(): string {
  return `${ORAL_HEALTH_PREFIX}periodontal:diabetes`;
}

export interface OralHealthInput {
  // Whether the profile has an ACTIVE diabetes condition (resolved via the shared
  // deriveRiskFactors "diabetes" factor upstream).
  hasDiabetes: boolean;
}

export interface OralHealthObservation {
  dedupeKey: string;
  title: string;
  detail: string;
}

// Decide whether to surface the diabetes↔periodontitis note. Emits ONLY for a
// profile with active diabetes; null otherwise. Pure.
export function decidePeriodontalObservation(
  input: OralHealthInput
): OralHealthObservation | null {
  if (!input.hasDiabetes) return null;
  return {
    dedupeKey: periodontalObservationKey(),
    title: "Gum health and blood sugar reinforce each other",
    // Observational: states the bidirectional relationship as information; the
    // actionable cadence side (more frequent dental visits) lives in the preventive
    // engine, not here.
    detail:
      "Diabetes and gum disease (periodontitis) are linked in both directions — " +
      "higher blood sugar makes gum inflammation more likely, and gum disease can " +
      "make blood sugar harder to control. Keeping up with dental cleanings and " +
      "day-to-day oral care supports your glycemic control too. Worth mentioning to " +
      "your dentist and your diabetes clinician.",
  };
}
