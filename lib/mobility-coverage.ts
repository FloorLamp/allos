// Pure mobility-coverage computation (issue #840, point 3) — the mobility flavor of
// muscle coverage, kept DELIBERATELY APART from strength's trained-coverage
// (lib/muscle-coverage.ts). Merging the two would answer the wrong question with a false
// all-clear (#482: trained ≠ mobilized), so this is its OWN view over its OWN input:
// recovery-session MOVE slugs, resolved through the mobility-move catalog's MuscleId
// tags, never through the lift catalog or `exercise_sets`.
//
// It reuses the SHARED #735 rollup machinery — a move's `muscles: MuscleId[]` roll up to
// MuscleRegion via muscleRegion() — exactly as strength coverage does, but sourced from
// mobility moves. This module MUST NOT import lib/muscle-coverage or read strength sets;
// a source-scan test (lib/__tests__/mobility-coverage-apart.test.ts) enforces that.

import { mobilityMoveBySlug } from "./mobility-moves";
import {
  muscleRegion,
  muscleLabel,
  type MuscleId,
  type MuscleRegion,
} from "./lifts";

// One mobility session (a recovery activity row): its date and the move slugs tapped.
export interface MobilitySessionInput {
  date: string; // YYYY-MM-DD
  moves: string[]; // canonical move slugs
}

// The distinct MuscleIds a single move mobilizes (empty for an unknown/retired slug).
export function musclesForMove(slug: string): MuscleId[] {
  return mobilityMoveBySlug(slug)?.muscles ?? [];
}

// The distinct MuscleRegions a single move mobilizes.
export function regionsForMove(slug: string): MuscleRegion[] {
  const seen = new Set<MuscleRegion>();
  for (const m of musclesForMove(slug)) seen.add(muscleRegion(m));
  return [...seen];
}

// Days (YYYY-MM-DD dates) fall within the window `[today - windowDays + 1, today]`.
function inWindow(date: string, today: string, windowDays: number): boolean {
  if (windowDays <= 0) return true;
  const d = Date.parse(`${date}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const diff = Math.round((t - d) / 86_400_000);
  return diff >= 0 && diff < windowDays;
}

// The ONE gather (one question, one computation): per MuscleRegion, the DISTINCT DATES on
// which any tapped move mobilized that region, within the window. Both the coverage strip
// (count = set size, lastMobilized = max date) and the mobility_region frequency counter
// (once-per-day dedup, #223) read this — never a second grouping.
export function mobilityRegionDays(
  sessions: MobilitySessionInput[],
  today: string,
  windowDays = 7
): Map<MuscleRegion, Set<string>> {
  const out = new Map<MuscleRegion, Set<string>>();
  for (const s of sessions) {
    if (!inWindow(s.date, today, windowDays)) continue;
    const regions = new Set<MuscleRegion>();
    for (const slug of s.moves)
      for (const r of regionsForMove(slug)) regions.add(r);
    for (const r of regions) {
      let set = out.get(r);
      if (!set) {
        set = new Set<string>();
        out.set(r, set);
      }
      set.add(s.date);
    }
  }
  return out;
}

// A per-MuscleId variant (for a finer strip if ever wanted): distinct dates per MuscleId.
export function mobilityMuscleDays(
  sessions: MobilitySessionInput[],
  today: string,
  windowDays = 7
): Map<MuscleId, Set<string>> {
  const out = new Map<MuscleId, Set<string>>();
  for (const s of sessions) {
    if (!inWindow(s.date, today, windowDays)) continue;
    const muscles = new Set<MuscleId>();
    for (const slug of s.moves)
      for (const m of musclesForMove(slug)) muscles.add(m);
    for (const m of muscles) {
      let set = out.get(m);
      if (!set) {
        set = new Set<string>();
        out.set(m, set);
      }
      set.add(s.date);
    }
  }
  return out;
}

// One row of the mobility coverage strip.
export interface MobilityCoverageRow {
  region: MuscleRegion;
  label: string;
  days: number; // distinct days this region was mobilized in the window
  lastMobilized: string | null; // most recent date, or null
}

// The 7 MuscleRegions in a stable display order (matches the strength coverage regions).
const REGION_ORDER: MuscleRegion[] = [
  "Chest",
  "Back",
  "Shoulders",
  "Arms",
  "Legs",
  "Glutes",
  "Core",
];

// The coverage strip rows for a window: one row per region, sorted most-mobilized first
// then by display order. Regions with zero coverage are INCLUDED (days: 0) so the strip
// can surface "Shoulders 0 this week" — the whole point of a coverage view.
export function mobilityCoverageStrip(
  sessions: MobilitySessionInput[],
  today: string,
  windowDays = 7
): MobilityCoverageRow[] {
  const days = mobilityRegionDays(sessions, today, windowDays);
  return REGION_ORDER.map((region) => {
    const dates = days.get(region);
    const sorted = dates ? [...dates].sort() : [];
    return {
      region,
      label: region,
      days: sorted.length,
      lastMobilized: sorted.length ? sorted[sorted.length - 1] : null,
    };
  }).sort((a, b) => b.days - a.days || REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region));
}

// The display label for a MuscleId (re-export so a finer strip renders through the shared
// formatter rather than inventing labels).
export function mobilityMuscleLabel(m: MuscleId): string {
  return muscleLabel(m);
}
