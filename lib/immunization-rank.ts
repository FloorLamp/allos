// The vaccine picker ORDER (issue #1677). Pure — no DB, no network.
//
// `PICKER_NAMES` is the ACIP schedule order: infancy first. `Combobox` shows 8 rows and
// an empty query keeps source order, so an adult adding a flu shot opens on Hepatitis B,
// Rotavirus, DTaP, Hib, PCV, IPV, MMR, Varicella — an infant's first year, none of which
// that adult will ever be given again.
//
// The fix is not a second schedule: the status engine (`assessSchedule`) ALREADY knows,
// per profile, which vaccines are due, which are finished, and which are outside this
// person's age/sex window. This module is the ONE pure translation of those stable
// per-vaccine statuses into picker order:
//
//   1. due / overdue — the plausible next dose
//   2. up to date / unknown — in-window, a booster or a gap worth recording
//   3. complete / immune — had it; still loggable (a titer, a re-record, a travel dose)
//   4. not recommended — outside the age or sex window; the pediatric rows sink here
//   5. declined — the profile said no; last, never removed
//
// Within a bucket the ACIP order is preserved, so the ordering adds relevance without
// inventing a new opinion. A COMBINATION shot has no schedule of its own, so it takes
// the best bucket of the components it credits — Vaxelis sinks for an adult exactly as
// its DTaP/Hib components do, and ProQuad rides up with a child's MMR.
//
// ORDERING ONLY: every vaccine stays in the list and reachable by search, and the free
// text semantics of the field are untouched.

import {
  CATALOG,
  COMBINATIONS,
  expandToComponents,
} from "./immunization-catalog";
import type { VaccineStatus } from "./immunization-status";

// The one status fact this ranker needs. `assessSchedule` produces a superset of it.
export interface VaccineRankFact {
  code: string;
  status: VaccineStatus;
}

// Lower sorts first. The buckets ARE the ranking — no counts, no timestamps, so the
// same profile on the same day always gets the same picker (`rank-core`/#1490).
const BUCKETS: Record<VaccineStatus, number> = {
  overdue: 0,
  due: 0,
  up_to_date: 1,
  unknown: 1,
  complete: 2,
  not_recommended: 3,
  declined: 4,
};

// The bucket a combination inherits: the best (lowest) bucket among the components it
// credits. A combo whose components are all unknown to the fact set stays neutral.
const NEUTRAL_BUCKET = BUCKETS.complete;

// The picker order for a profile whose schedule has been assessed (#1677). `facts` is
// the per-catalog-vaccine status set; anything missing from it falls back to the neutral
// bucket, so a partial fact set degrades to catalog order rather than to nonsense.
// Returns display NAMES, the same membership and spelling `PICKER_NAMES` offers.
export function rankedVaccineOptions(
  facts: readonly VaccineRankFact[]
): string[] {
  const bucketByCode = new Map<string, number>();
  for (const fact of facts) {
    const bucket = BUCKETS[fact.status];
    if (bucket === undefined) continue;
    const prev = bucketByCode.get(fact.code);
    if (prev === undefined || bucket < prev)
      bucketByCode.set(fact.code, bucket);
  }

  const rows: { name: string; bucket: number; order: number }[] = [];
  let order = 0;
  for (const entry of CATALOG) {
    rows.push({
      name: entry.name,
      bucket: bucketByCode.get(entry.code) ?? NEUTRAL_BUCKET,
      order: order++,
    });
  }
  for (const combo of COMBINATIONS) {
    // Best (lowest) bucket across the components, each falling back to neutral: a
    // combination is as relevant as the most relevant thing it covers, so Twinrix
    // stays offered for its Hep A half even when Hep B has been declined.
    const buckets = expandToComponents(combo.code).map(
      (code) => bucketByCode.get(code) ?? NEUTRAL_BUCKET
    );
    rows.push({
      name: combo.name,
      bucket: buckets.length ? Math.min(...buckets) : NEUTRAL_BUCKET,
      order: order++,
    });
  }

  return rows
    .sort((a, b) => a.bucket - b.bucket || a.order - b.order)
    .map((r) => r.name);
}
