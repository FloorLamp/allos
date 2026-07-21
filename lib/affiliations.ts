// Pure logic for provider ↔ provider AFFILIATION edges (issue #1055): the
// individual-clinician ↔ organization link, derived-first (suggest-and-accept, the
// #1050 mechanics). No DB/network — the DB layer (lib/queries/affiliations.ts)
// gathers co-occurrence rows and persists the accept/decline decision; this module
// is the exhaustively unit-testable suggestion math.
//
// DESIGN. An affiliation is DERIVED from co-occurrence — every encounter (and
// appointment) that pairs a clinician (`provider_id`) with a facility
// (`location_provider_id`) on the SAME row is an observed affiliation. Suggestions
// are computed at READ time over whatever rows exist now; the ONLY stored state is
// the accepted EDGE (provider_affiliations, status='linked') and the DECLINED
// decision (status='declined'). No silent auto-link, ever — even heavy co-occurrence
// (a locum's one-off shift is co-occurrence too), so ≥1 shared visit is a *strong
// suggestion*, never a fact.
//
// TYPE DISCIPLINE (#1051). The edge is strictly individual ↔ organization. The
// co-occurrence input carries each side's provider `type`, and a pair is a candidate
// ONLY when one side is an `individual` and the other an `organization` — an
// individual↔individual or org↔org co-occurrence is structurally dropped, so the
// schema shape (individual_id / organization_id) can never be violated.

import type { ProviderType } from "./types";

// The stable, order-fixed key for an (individual, organization) affiliation pair.
// Ids never recycle (AUTOINCREMENT), so the integer pair is a durable identity — a
// declined decision keyed on it survives forever, the #203 name-vs-id distinction on
// the id side. The order is fixed (individual first) because the edge is directional
// by role, so there is exactly one key per real-world affiliation.
export function affiliationPairKey(
  individualId: number,
  organizationId: number
): string {
  return `${individualId}:${organizationId}`;
}

// One observed co-occurrence between two providers, as read off the encounter /
// appointment rows: the attending clinician and the facility, each with its
// registry `type`, plus how many shared visits produced it.
export interface CoOccurrence {
  clinicianId: number;
  clinicianType: ProviderType;
  facilityId: number;
  facilityType: ProviderType;
  sharedVisits: number;
}

// A suggested affiliation: the resolved individual/organization ids (role-normalized
// from the co-occurrence), the shared-visit count, and a short reason string the UI
// renders ("6 visits at Sample Care East"). All suggestions are `strong` (≥1 shared
// visit) — the co-occurrence IS the signal — but the field is explicit so a future
// weaker tier can join without reshaping callers.
export interface SuggestedAffiliation {
  individualId: number;
  organizationId: number;
  sharedVisits: number;
  strength: "strong";
}

// Fold a raw co-occurrence into the canonical (individual, organization) pair, or
// null when it isn't a valid individual↔organization pairing (both individuals,
// both orgs, or a self-pair). This is the one place the schema's type invariant is
// enforced.
export function normalizeCoOccurrence(
  co: CoOccurrence
): { individualId: number; organizationId: number } | null {
  if (co.clinicianId === co.facilityId) return null; // self-affiliation is meaningless
  const clinicianIsIndividual = co.clinicianType === "individual";
  const facilityIsOrg = co.facilityType === "organization";
  // The common shape: an individual clinician at an organization facility.
  if (clinicianIsIndividual && facilityIsOrg)
    return { individualId: co.clinicianId, organizationId: co.facilityId };
  // The inverted shape (an org named as attending, an individual as location) is
  // rare but valid — normalize it to the same canonical pair.
  if (co.clinicianType === "organization" && co.facilityType === "individual")
    return { individualId: co.facilityId, organizationId: co.clinicianId };
  // individual↔individual or organization↔organization: not an affiliation.
  return null;
}

// Compute the suggested affiliations from co-occurrence rows, minus any pair already
// LINKED (an existing edge) or DECLINED (a remembered decision). Merges duplicate
// pairs (summing shared visits — the same clinician/facility can co-occur through
// several encounters) and sorts strongest-first. Pure + exhaustively tested.
export function suggestAffiliations(
  coOccurrences: CoOccurrence[],
  linkedKeys: ReadonlySet<string>,
  declinedKeys: ReadonlySet<string>
): SuggestedAffiliation[] {
  const merged = new Map<string, { i: number; o: number; visits: number }>();
  for (const co of coOccurrences) {
    const norm = normalizeCoOccurrence(co);
    if (!norm) continue;
    const key = affiliationPairKey(norm.individualId, norm.organizationId);
    const prev = merged.get(key);
    merged.set(key, {
      i: norm.individualId,
      o: norm.organizationId,
      visits: (prev?.visits ?? 0) + Math.max(0, co.sharedVisits),
    });
  }
  const out: SuggestedAffiliation[] = [];
  for (const [key, v] of merged) {
    if (v.visits <= 0) continue;
    if (linkedKeys.has(key) || declinedKeys.has(key)) continue;
    out.push({
      individualId: v.i,
      organizationId: v.o,
      sharedVisits: v.visits,
      strength: "strong",
    });
  }
  // Strongest first, then a stable id tiebreak so the order is deterministic.
  out.sort(
    (a, b) =>
      b.sharedVisits - a.sharedVisits ||
      a.individualId - b.individualId ||
      a.organizationId - b.organizationId
  );
  return out;
}
