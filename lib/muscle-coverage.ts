import { daysBetweenDateStr } from "@/lib/date";
import {
  exerciseHistoryKey,
  liftInfo,
  muscleLabel,
  muscleRegion,
  type LiftDef,
  type MuscleId,
  type MuscleRegion,
} from "@/lib/lifts";

/**
 * Muscle-coverage attribution — THE one computation that turns logged sets into
 * per-`MuscleId` volume (#221/#482). Every muscle-keyed surface (the list-first
 * coverage on Training → Overview, the future SVG heat #737, the volume-band
 * verdict #742, and any "pull untrained for 9 days" line) is a formatter over
 * `coverageFromSets`'s result — never a second, hand-rolled attribution.
 *
 * Identity flows strictly through `exerciseHistoryKey` → catalog `LiftDef` →
 * `primaryMuscles`/`secondaryMuscles`, so a variant and its base credit the same
 * muscles (Barbell Curl ≡ Curl) and there is no second grouping (#432).
 */

/**
 * Indirect credit: a set counts 1.0 toward each primary muscle and this fraction
 * toward each secondary. The ONE named constant for the secondary weight.
 */
export const SECONDARY_CREDIT = 0.5;
const PRIMARY_CREDIT = 1.0;

/** A logged set, reduced to what attribution needs: its exercise name and date. */
export interface CoverageSet {
  exercise: string;
  date: string; // YYYY-MM-DD
}

/** Per-muscle coverage: accumulated (possibly fractional) set credit + recency. */
export interface MuscleCoverage {
  sets: number;
  lastTrained: string | null; // YYYY-MM-DD of the most recent crediting set
}

/**
 * The catalog `LiftDef` for a logged exercise, resolved STRICTLY through
 * `exerciseHistoryKey`. Returns undefined for a custom (non-catalog) lift so it
 * contributes nothing (no muscle tags until the deferred #744) — including
 * rejecting `liftInfo`'s loose contains-fallback: only an exact canonical-key
 * match counts, so "Front Squat Variation" (a custom lift) is not silently
 * credited as "Front Squat".
 */
function catalogDefFor(exercise: string): LiftDef | undefined {
  const key = exerciseHistoryKey(exercise);
  const info = liftInfo(key);
  if (!info) return undefined;
  return exerciseHistoryKey(info.name) === key ? info : undefined;
}

function credit(
  out: Map<MuscleId, MuscleCoverage>,
  muscles: MuscleId[],
  amount: number,
  date: string
): void {
  for (const m of muscles) {
    const cur = out.get(m);
    if (!cur) {
      out.set(m, { sets: amount, lastTrained: date });
    } else {
      cur.sets += amount;
      if (cur.lastTrained === null || date > cur.lastTrained) {
        cur.lastTrained = date;
      }
    }
  }
}

/**
 * Attribute each logged set to muscles, returning per-`MuscleId` set credit and
 * the date it was last trained. Primary muscles get `PRIMARY_CREDIT` (1.0),
 * secondary `SECONDARY_CREDIT` (0.5). Custom lifts contribute nothing.
 *
 * When `windowDays` is given, only sets whose date falls in the trailing window
 * ending on `today` are counted — a set is in-window iff it is `today` or one of
 * the `windowDays - 1` prior days (future dates and anything `>= windowDays` days
 * ago are excluded). This is the weekly-coverage mode (`windowDays = 7`). Omit
 * `windowDays` to attribute every passed set (the per-session / union mode, where
 * the caller has already scoped the rows to one session).
 *
 * Only muscles that received credit appear in the map; an untrained muscle is
 * simply absent (the `untrained` band verdict is #742's job to derive).
 */
export function coverageFromSets(
  sets: CoverageSet[],
  today: string,
  windowDays?: number
): Map<MuscleId, MuscleCoverage> {
  const out = new Map<MuscleId, MuscleCoverage>();
  for (const s of sets) {
    if (windowDays !== undefined) {
      const ago = daysBetweenDateStr(s.date, today);
      if (ago === null || ago < 0 || ago >= windowDays) continue;
    }
    const def = catalogDefFor(s.exercise);
    if (!def) continue;
    credit(out, def.primaryMuscles, PRIMARY_CREDIT, s.date);
    credit(out, def.secondaryMuscles, SECONDARY_CREDIT, s.date);
  }
  return out;
}

/**
 * The union of `MuscleId`s worked across a session's sets (per-session mode) —
 * the keys of the same attribution, so it can never disagree with the coverage
 * math. Custom lifts contribute nothing, so they drop out here too.
 */
export function musclesWorked(sets: CoverageSet[]): Set<MuscleId> {
  return new Set(coverageFromSets(sets, "").keys());
}

/** One row of the sorted, accessible coverage list (the permanent list-first UI). */
export interface CoverageListRow {
  muscle: MuscleId;
  label: string;
  region: MuscleRegion;
  sets: number;
  lastTrained: string | null;
}

/**
 * Flatten a coverage map into the sorted per-muscle list the UI renders — the
 * accessible rendering that ships WITH the computation and stays permanent (the
 * SVG figure #737 layers on top, never replacing it). Sorted by set volume
 * descending, then label ascending for a stable order.
 */
export function coverageList(
  coverage: Map<MuscleId, MuscleCoverage>
): CoverageListRow[] {
  return [...coverage.entries()]
    .map(([muscle, c]) => ({
      muscle,
      label: muscleLabel(muscle),
      region: muscleRegion(muscle),
      sets: c.sets,
      lastTrained: c.lastTrained,
    }))
    .sort((a, b) => b.sets - a.sets || a.label.localeCompare(b.label));
}
