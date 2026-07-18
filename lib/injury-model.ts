// Pure injury-layer model (issue #838). Types + validation + the region-constraint
// shaping the recommendation engine consumes — no DB, no network, so it's unit-testable
// and shared by the DB cores (lib/injuries.ts), the Server Actions, and the pure
// recommendation model (lib/workout-recommendation.ts).
//
// An injury is the USER'S explicit constraint — "this region is off the table" — the
// equipment-availability class of #666's context taxonomy (physical possibility, may
// re-rank), NOT the medical-judgment class (conditions, note-only). So the engine may
// EXCLUDE an active injury's regions from recommendations/nags — but always DISCLOSED on
// the card ("avoiding Chest (right shoulder injury)"), never silent.

import {
  muscleRegion,
  REGION_SCOPES,
  MUSCLE_IDS,
  type MuscleId,
  type MuscleRegion,
} from "./lifts";

export type InjuryStatus = "active" | "recovering" | "resolved";
export const INJURY_STATUSES: readonly InjuryStatus[] = [
  "active",
  "recovering",
  "resolved",
];

// A stored injury row (the read shape). `regions` is the coarse MuscleRegion[] the engine
// excludes/tempers on; `muscles` is the optional finer MuscleId[] (#735), for display.
export interface Injury {
  id: number;
  label: string;
  regions: MuscleRegion[];
  muscles: MuscleId[];
  status: InjuryStatus;
  since: string | null;
  resolvedDate: string | null;
  notes: string | null;
  createdAt: string;
}

// The slice of an injury the recommendation model reads (id + label + status + regions).
// Only NON-resolved injuries become constraints; a resolved injury keeps its record but
// exerts no engine effect.
export interface InjuryConstraint {
  id: number;
  label: string;
  status: "active" | "recovering";
  regions: MuscleRegion[];
}

// A single YYYY-MM-DD validator (shared with the actions).
export function isDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const REGION_SET = new Set<string>(REGION_SCOPES);
const MUSCLE_SET = new Set<string>(MUSCLE_IDS);

export function isValidRegion(r: string): r is MuscleRegion {
  return REGION_SET.has(r);
}
export function isValidMuscleId(m: string): m is MuscleId {
  return MUSCLE_SET.has(m);
}

// Parse a stored/submitted `regions` JSON blob into a de-duplicated MuscleRegion[]. Drops
// anything not in the coarse vocabulary rather than throwing (a defensive read); the
// action-layer validation rejects an empty result before a write.
export function parseRegions(raw: string | null | undefined): MuscleRegion[] {
  return dedupe(parseStringArray(raw).filter(isValidRegion));
}

// Parse a stored/submitted `muscles` JSON blob into a de-duplicated MuscleId[]. Also folds
// each fine muscle's coarse region into the region set at shaping time (below), so a user
// who picks only fine muscles still constrains the right coarse regions.
export function parseMuscles(raw: string | null | undefined): MuscleId[] {
  return dedupe(parseStringArray(raw).filter(isValidMuscleId));
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// The full constraint region set for an injury: its declared coarse regions PLUS the
// coarse rollup of any finer muscles it names — so picking "biceps" (a MuscleId) also
// constrains the "Arms" region the engine reasons over. Pure; deterministic order
// (REGION_SCOPES order).
export function injuryRegions(
  regions: MuscleRegion[],
  muscles: MuscleId[]
): MuscleRegion[] {
  const set = new Set<MuscleRegion>(regions);
  for (const m of muscles) set.add(muscleRegion(m));
  return REGION_SCOPES.filter((r) => set.has(r));
}

// The recovering-injury LOAD tempering fraction (issue #838): a recovering region's
// suggest-next-set target backs off to this fraction of the last pre-injury working
// weight — a documented, conservative heuristic, a SUGGESTION never a lockout (the user
// can always log anything). 0.6 = "start around 60%, rebuild".
export const RECOVERING_LOAD_FACTOR = 0.6;

// Shape stored injury rows into the constraints the engine reads: NON-resolved only, with
// the full region set (coarse + fine rollup). Resolved injuries are dropped (record kept,
// no effect). Deterministic order (input order).
export function injuryConstraints(injuries: Injury[]): InjuryConstraint[] {
  const out: InjuryConstraint[] = [];
  for (const inj of injuries) {
    if (inj.status === "resolved") continue;
    out.push({
      id: inj.id,
      label: inj.label,
      status: inj.status,
      regions: injuryRegions(inj.regions, inj.muscles),
    });
  }
  return out;
}

// The set of regions EXCLUDED by ACTIVE injuries (active only — recovering regions are
// tempered, not excluded). Pure.
export function excludedRegions(
  constraints: readonly InjuryConstraint[]
): Set<MuscleRegion> {
  const s = new Set<MuscleRegion>();
  for (const c of constraints)
    if (c.status === "active") for (const r of c.regions) s.add(r);
  return s;
}

// The set of regions TEMPERED by RECOVERING injuries. A region that is ALSO actively
// injured stays excluded (exclusion wins), so tempering is the recovering-only remainder.
export function temperedRegions(
  constraints: readonly InjuryConstraint[]
): Set<MuscleRegion> {
  const excluded = excludedRegions(constraints);
  const s = new Set<MuscleRegion>();
  for (const c of constraints)
    if (c.status === "recovering")
      for (const r of c.regions) if (!excluded.has(r)) s.add(r);
  return s;
}

// One disclosure line entry: a region excluded from the recommendation and the injuries
// responsible for it, so a surface can render "avoiding Chest (right shoulder injury)".
export interface ExcludedRegionDisclosure {
  region: MuscleRegion;
  // The active-injury labels covering this region, de-duplicated in input order.
  injuryLabels: string[];
}

// The disclosure for every ACTIVE-injury-excluded region, so the exclusion is NEVER
// silent (#838 / the #666 never-gate-silently rule satisfied by disclosure). Ordered by
// REGION_SCOPES for a stable read. Empty when no active injury.
export function excludedRegionDisclosures(
  constraints: readonly InjuryConstraint[]
): ExcludedRegionDisclosure[] {
  const byRegion = new Map<MuscleRegion, string[]>();
  for (const c of constraints) {
    if (c.status !== "active") continue;
    for (const r of c.regions) {
      const labels = byRegion.get(r) ?? [];
      if (!labels.includes(c.label)) labels.push(c.label);
      byRegion.set(r, labels);
    }
  }
  return REGION_SCOPES.filter((r) => byRegion.has(r)).map((region) => ({
    region,
    injuryLabels: byRegion.get(region)!,
  }));
}

// The one-line human disclosure for an excluded region: "Chest (right shoulder injury)".
// The word "injury" is appended when the label(s) don't already carry it, so a bare label
// ("right shoulder") reads naturally and a self-describing one ("shoulder injury") isn't
// doubled.
export function excludedRegionLabel(d: ExcludedRegionDisclosure): string {
  const labels = d.injuryLabels.join(", ");
  const suffix = /injur/i.test(labels) ? "" : " injury";
  return `${d.region} (${labels}${suffix})`;
}
