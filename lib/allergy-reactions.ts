// Allergy manifestations + safety vocabulary — the PURE half (issue #1405).
//
// An allergy used to hold exactly ONE reaction and no criticality or verification
// status, so a peanut allergy that causes BOTH hives and anaphylaxis lost half its
// story, and a SUSPECTED penicillin allergy, a CONFIRMED one, and one a challenge
// test REFUTED were the same indistinguishable row. Migration 122 added
// `allergies.criticality`, `allergies.verification_status`, and the
// `allergy_reactions` child table; this module owns every decision derived from
// them, so the allergy list, the passport, the emergency card, the drug-allergy
// safety matcher and the FHIR export can never disagree.
//
// Imports NOTHING impure (no db, no network) — it lives in the pure vitest tier.

import type {
  AllergyCriticality,
  AllergyManifestation,
  AllergyVerificationStatus,
} from "./types/medical";

// One graded manifestation, as rendered/exported. Shape lives in lib/types (the
// source of truth for record shapes); re-exported here because this module owns the
// composition that produces it.
export type { AllergyManifestation };

// The reaction-SEVERITY vocabulary (issue #1676). The column is free TEXT by design
// (sources print whatever they print, and migration 122 kept it that way), but the
// FORM was a bare input, so a hand-entered grade was one of infinitely many
// spellings. These are the three FHIR AllergyIntolerance.reaction.severity values,
// ordinal from mildest — an enum where the entry surface is concerned, with a loaded
// non-standard value preserved verbatim rather than silently rewritten.
export const ALLERGY_REACTION_SEVERITIES = [
  "mild",
  "moderate",
  "severe",
] as const;

export type AllergyReactionSeverity =
  (typeof ALLERGY_REACTION_SEVERITIES)[number];

// Labels that say what the grade MEANS, so "moderate" and "severe" aren't told apart
// by tone alone.
export const ALLERGY_REACTION_SEVERITY_LABELS: Record<
  AllergyReactionSeverity,
  string
> = {
  mild: "Mild — local, settled on its own",
  moderate: "Moderate — needed treatment",
  severe: "Severe — systemic or emergency care",
};

// Whether a stored grade is one of the three canonical values (case-insensitive).
// A false answer is not an error: it means the value came from a source with its own
// wording and must be shown as recorded.
export function isCanonicalReactionSeverity(
  severity: string | null | undefined
): boolean {
  const s = severity?.trim().toLowerCase();
  return !!s && ALLERGY_REACTION_SEVERITIES.some((v) => v === s);
}

// ── The cached-first-row invariant ────────────────────────────────────────────
//
// `allergies.reaction` / `.severity` were NOT retired when `allergy_reactions`
// arrived: ~10 read sites select them (Timeline, Search, CSV export, the
// cross-document representative CTE's dedup identity), and retracting the columns
// would silently change all of them. They stay as a DENORMALIZED CACHE of the FIRST
// manifestation, maintained by the one write core (lib/allergy-write).
//
// This function is the ONE read-side composition: the child rows when the allergy
// has any, else the cached scalar as a single implicit manifestation. That fallback
// is what lets an IMPORTED row — which the document pipeline writes with the scalar
// only — read identically to a hand-entered multi-reaction one, with no per-reader
// special case and no import-time child write to keep in sync.
export function composeAllergyReactions(
  allergy: { reaction: string | null; severity: string | null },
  childRows: readonly {
    manifestation: string;
    severity: string | null;
    position: number;
  }[] = []
): AllergyManifestation[] {
  if (childRows.length > 0) {
    return [...childRows]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        manifestation: r.manifestation,
        severity: r.severity ?? null,
      }));
  }
  const only = allergy.reaction?.trim();
  if (!only) return [];
  return [{ manifestation: only, severity: allergy.severity ?? null }];
}

// A one-line summary of the manifestations, for a compact row: "Hives · Anaphylaxis
// (severe)". A manifestation with no grade prints bare — an unstated severity is a
// real answer and must never be printed as a guessed one. Empty list → "".
export function allergyReactionSummary(
  items: readonly AllergyManifestation[]
): string {
  return items
    .map((r) =>
      r.severity?.trim()
        ? `${r.manifestation} (${r.severity.trim()})`
        : r.manifestation
    )
    .join(" · ");
}

// ── Verification status: what an allergy is ALLOWED to do ─────────────────────

// Verification statuses that mean "this is not (or is no longer) a real allergy for
// this person". A REFUTED allergy was actively ruled out — treating it as live is
// how a patient gets denied a first-line antibiotic for no reason — and an
// ENTERED-IN-ERROR row was never an allergy at all.
const NON_ACTIONABLE: readonly AllergyVerificationStatus[] = [
  "refuted",
  "entered-in-error",
];

// Should this allergy gate anything — the drug-allergy safety matcher, the food /
// supplement screens, the emergency card, the passport's known-allergy list?
//
// ONE computation for every one of those questions (#1405). NULL verification_status
// is ACTIONABLE: "unstated" is the pre-#1405 world and every legacy row means it, so
// treating it as non-actionable would silently switch off safety screening for the
// entire existing corpus. Only an EXPLICIT refuted / entered-in-error opts out.
export function isAllergyActionable(allergy: {
  verification_status: AllergyVerificationStatus | null;
}): boolean {
  return !(
    allergy.verification_status != null &&
    NON_ACTIONABLE.includes(allergy.verification_status)
  );
}

// Display labels. Kept here (not in a component) so the list, the passport and the
// emergency card name the same value identically.
const CRITICALITY_LABELS: Record<AllergyCriticality, string> = {
  low: "Low criticality",
  high: "High criticality",
  "unable-to-assess": "Criticality unassessed",
};

export function allergyCriticalityLabel(
  criticality: AllergyCriticality | null
): string | null {
  return criticality ? CRITICALITY_LABELS[criticality] : null;
}

const VERIFICATION_LABELS: Record<AllergyVerificationStatus, string> = {
  unconfirmed: "Unconfirmed",
  suspected: "Suspected",
  confirmed: "Confirmed",
  refuted: "Refuted",
  "entered-in-error": "Entered in error",
};

export function allergyVerificationLabel(
  status: AllergyVerificationStatus | null
): string | null {
  return status ? VERIFICATION_LABELS[status] : null;
}

// Is this allergy flagged as potentially life-threatening on a future exposure?
// The emergency card and the passport lead with these. 'unable-to-assess' is NOT
// high — it is an explicit "we don't know", and promoting it would manufacture a
// claim the source never made.
export function isHighCriticality(allergy: {
  criticality: AllergyCriticality | null;
}): boolean {
  return allergy.criticality === "high";
}
