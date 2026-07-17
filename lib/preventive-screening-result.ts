// The screening-RESULT → preventive-cadence bridge (issue #686). The screening
// counterpart of titerImmuneStatus (lib/immunization-status.ts): titerImmuneStatus
// interprets a serology titer so an immune result completes a vaccine and suppresses
// its nudge; this interprets a qualitative screening RESULT so it SATISFIES the
// matching preventive screening rule and advances its cadence — the SAME
// `(ruleKey, date)` satisfaction stream the #86 name/code inference and the manual
// "mark done" events feed, so there is NO second cadence engine: the one pure assessor
// (lib/preventive-status.ts) computes the interval from whichever satisfaction is
// newest, per rule.
//
// Why this closes a real gap: the #86 inference (lib/preventive-inference.ts) matches
// the TEST that was performed (a CPT code or a name synonym). But hiv_screening and
// hepatitis_b carry NO concept-map entry at all (manual-only until now), and
// cervical_cancer is inferred only from a Pap/HPV *test* name or CPT — an Epic HPV
// RESULT row that carries only a LOINC (30167-1) and a name like "HPV, High Risk"
// matches neither, so the result the record already contains never advances the clock.
// classifyQualitativeResult (#549, LOINC-hinted since #684) is the single judge that
// recognizes such a result; this maps its CONCEPT to the screening rule.
//
// Exclusion discipline (#482 / #86 conservatism): only concepts that have a catalog
// SCREENING rule are mapped. Chlamydia / gonorrhea / syphilis / Group B Strep are named
// in the issue but have NO preventive rule in the catalog, so a result of one of those
// satisfies NOTHING here rather than a wrong rule — adding those rules is a separate
// dataset decision. Being TESTED advances the cadence regardless of the result's
// polarity (a negative HIV screen and a positive one both mean "you were screened on
// this date"); the classifier's non-null verdict is the gate that the row is a genuine,
// interpretable qualitative result, not that it is positive.

import { classifyQualitativeResult } from "./reference-range";
import type { PreventiveSatisfaction } from "./preventive-status";

interface ScreeningResultConcept {
  // The catalog screening rule a result of this concept satisfies.
  ruleKey: string;
  // Exact LOINCs (from the #684 qualitative-class table) that identify the concept —
  // the deterministic hint, checked first.
  loincs: Set<string>;
  // Name fallback for a result row without a (mapped) LOINC. Optional: HPV has no name
  // fallback because the classifier's INFECTION_MARKER doesn't include HPV, so a
  // name-only HPV row doesn't classify (returns null) and is recognized ONLY by its
  // LOINC — which real Epic exports carry (#684). Expanding the classifier to name-
  // match HPV would ripple into the flag surface, out of #686's cadence-only scope.
  name?: RegExp;
}

const SCREENING_RESULT_CONCEPTS: ScreeningResultConcept[] = [
  {
    // HPV (high-risk / genotype) → cervical-cancer screening (#686 headline case).
    // LOINC-only for the reason on `name` above.
    ruleKey: "cervical_cancer",
    loincs: new Set([
      "30167-1", // HPV high risk
      "59263-4", // HPV genotype 16
      "75694-0", // HPV genotype 18/45
    ]),
  },
  {
    ruleKey: "hiv_screening",
    loincs: new Set(["56888-1"]), // HIV Ag/Ab, 4th generation
    name: /\bhiv\b/i,
  },
  {
    ruleKey: "hepatitis_c",
    loincs: new Set(["13955-0"]), // Hepatitis C antibody
    name: /hepatitis\s*c\b|\bhcv\b/i,
  },
  {
    // Hepatitis B SURFACE ANTIGEN — the infection screen. The surface ANTIBODY
    // (anti-HBs, immunity) must NOT satisfy this: it classifies as immunity, its LOINC
    // isn't 5196-1, and "surface antibody" doesn't match the antigen-specific name.
    ruleKey: "hepatitis_b",
    loincs: new Set(["5196-1"]), // Hepatitis B surface antigen
    name: /hbsag|hepatitis\s*b\s*surface\s*antigen/i,
  },
];

export interface ScreeningResultInput {
  name: string;
  value: string | null;
  notes: string | null;
  reference: string | null;
  loinc?: string | null;
  date?: string | null;
}

// The preventive screening rule a qualitative result satisfies, or null. The
// classifier is the single judge (#549): a row that doesn't classify to a recognized
// qualitative result (infection / immunity / screen) returns null here — a blank or
// uninterpretable value never counts as a screening event. A recognized result then
// resolves its CONCEPT by LOINC (deterministic) or, failing that, the concept name.
export function screeningResultRuleKey(
  rec: ScreeningResultInput
): string | null {
  const c = classifyQualitativeResult(
    rec.name,
    rec.value,
    rec.notes,
    rec.reference,
    rec.loinc
  );
  if (!c) return null;
  const loinc = (rec.loinc ?? "").trim();
  for (const concept of SCREENING_RESULT_CONCEPTS) {
    if (loinc && concept.loincs.has(loinc)) return concept.ruleKey;
    if (concept.name?.test(rec.name)) return concept.ruleKey;
  }
  return null;
}

// Every screening satisfaction implied by a set of qualitative result rows — the SAME
// `(ruleKey, date)` shape the manual + #86 streams emit, so the caller concatenates
// these and hands the union to the one assessor (which takes the newest per rule). A
// row with no usable date is dropped (it can't be placed on the cadence timeline).
export function inferScreeningResultSatisfactions(
  results: ScreeningResultInput[]
): PreventiveSatisfaction[] {
  const out: PreventiveSatisfaction[] = [];
  for (const r of results) {
    const date = (r.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ruleKey = screeningResultRuleKey(r);
    if (ruleKey) out.push({ ruleKey, date });
  }
  return out;
}
