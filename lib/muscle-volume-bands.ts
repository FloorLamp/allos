// Per-muscle weekly WORKING-SET volume bands (issue #742) — the reference layer
// that turns #736's raw per-`MuscleId` set counts (`coverageFromSets`) into a
// coaching verdict (`below | within | above | untrained`). PURE and client-safe
// (no DB/network), so the same verdict runs in the Overview coverage list, the
// future SVG anatomy tint (#737), and the coaching-tier observation engine below —
// ONE verdict function, ONE palette, consumed by every surface (the #721
// `lib/training-zones.ts` precedent: a value is computed once and formatted many
// times, so tints, labels, and findings can never drift).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE NUMBERS COME FROM (the open question the spec carries — resolved here
// with sources, not magic constants):
//
// 1. The {low, high} band = [MEV, MAV] from the Renaissance Periodization
//    "Training Volume Landmarks for Muscle Growth" framework (Israetel, Hoffmann,
//    Smith; RP, 2017–2021). MEV = Minimum Effective Volume (the fewest hard
//    weekly sets that still drives growth) and MAV = Maximum Adaptive Volume (the
//    upper end where added sets stop paying off before recovery suffers). Below
//    MEV a muscle is under-stimulated; above MAV is junk/over-reaching volume.
//    The landmarks are published per muscle group as weekly-set ranges — large
//    prime movers (chest, back, quads) land ~10–20 sets, while smaller or heavily
//    INDIRECTLY-trained muscles (forearms, calves, rear/front delts, abs) carry
//    lower landmarks because they accumulate stimulus as assistors on compound
//    lifts. The bands below round those published landmarks to whole sets.
//
// 2. The ~10-set lower shoulder on the big movers is corroborated by the
//    dose-response meta-analysis Schoenfeld, Ogborn & Krieger (2017),
//    "Dose-response relationship between weekly resistance training volume and
//    increases in muscle mass" (J Sports Sci 35(11):1073–1082): hypertrophy rises
//    with weekly set volume, and ≥10 sets/week produced markedly greater growth
//    than <5 — so a large mover sitting under ~10 sets is a real, evidence-based
//    shortfall, while the diminishing-returns curve motivates a finite upper band.
//
// 3. The 0.5 SECONDARY-CREDIT factor (owned by `lib/muscle-coverage.ts`,
//    re-exported here so the band interpretation and the counting convention stay
//    together) reflects that an assisting muscle receives sub-maximal mechanical
//    tension relative to the prime mover on a given lift. Counting an indirect set
//    as a fraction of a direct one is the standard RP fractional-set convention
//    (RP volume-landmark guidance: "count indirect work as roughly half a set");
//    0.5 is the round, widely-used value for that half-credit. It is deliberately
//    ONE constant (SECONDARY_CREDIT) so the counting rule the bands are read
//    against never forks.
//
// These are population defaults, not per-person prescriptions — there is NO
// per-profile override in v1 (a documented follow-up). They inform a calm display
// verdict and one dismissible observation; they are NOT a priority engine (#559)
// and never reorder the recommendation core's exercise ranking.
// ─────────────────────────────────────────────────────────────────────────────

import {
  muscleLabel,
  muscleRegion,
  MUSCLE_IDS,
  type MuscleId,
  type MuscleRegion,
} from "./lifts";
import { startOfWeekStr } from "./date";
import { SECONDARY_CREDIT } from "./muscle-coverage";

// Re-export so a reader of the bands has the counting convention (and its sourced
// justification above) in one place.
export { SECONDARY_CREDIT };

/** A weekly working-set band for one muscle: [MEV, MAV], inclusive on both ends. */
export interface VolumeBand {
  low: number; // MEV — below this the muscle is under-stimulated
  high: number; // MAV — above this is junk / over-reaching volume
}

/**
 * The checked-in weekly working-set band per `MuscleId`. A `Record` so TypeScript
 * enforces totality over the enum (every muscle has a band). See the module header
 * for the RP MEV–MAV / Schoenfeld sourcing. Large prime movers ~10–20; smaller and
 * heavily-indirect muscles lower, matching where their published landmarks sit.
 */
export const VOLUME_BANDS: Record<MuscleId, VolumeBand> = {
  // Large prime movers — RP landmarks cluster ~10 (MEV) to ~20 (MAV).
  chest: { low: 10, high: 20 },
  lats: { low: 10, high: 20 },
  quads: { low: 10, high: 20 },
  // Big posterior/lower movers with strong indirect loading — MEV a touch lower.
  hamstrings: { low: 8, high: 18 },
  glutes: { low: 8, high: 18 },
  "mid-back": { low: 8, high: 18 },
  // Shoulders: side delts tolerate and want moderate-high direct volume; front
  // delts get heavy indirect work from all pressing, so their direct MEV is low.
  "side-delts": { low: 8, high: 18 },
  "front-delts": { low: 6, high: 12 },
  "rear-delts": { low: 6, high: 14 },
  // Upper-chest fraction: a portion of chest volume, lower absolute landmark.
  "chest-upper": { low: 6, high: 12 },
  // Traps / lower back: accumulate large indirect loads (deadlifts, rows, carries),
  // so their DIRECT landmarks are modest.
  traps: { low: 6, high: 14 },
  "lower-back": { low: 6, high: 12 },
  // Arms: moderate-to-high tolerance, but also heavy indirect work on presses/pulls.
  biceps: { low: 8, high: 16 },
  triceps: { low: 8, high: 16 },
  forearms: { low: 4, high: 12 },
  // Core.
  abs: { low: 6, high: 16 },
  obliques: { low: 4, high: 12 },
  // Lower-leg / hips — smaller muscles, lower landmarks.
  calves: { low: 8, high: 16 },
  tibialis: { low: 4, high: 10 },
  "hip-adductors": { low: 4, high: 12 },
  "hip-abductors": { low: 4, high: 12 },
  neck: { low: 4, high: 12 },
};

/** The band for a muscle (total over the enum). */
export function volumeBand(muscle: MuscleId): VolumeBand {
  return VOLUME_BANDS[muscle];
}

// ---- The ONE verdict (computed once, formatted everywhere) -----------------

/**
 * A muscle's weekly volume relative to its band. `untrained` is a distinct state
 * from `below`: zero credited sets is "no answer yet" (neutral), not "under target"
 * — the same not-a-negative-answer discipline the cold-start gate enforces (#719).
 */
export type BandVerdict = "below" | "within" | "above" | "untrained";

/**
 * THE verdict function — the single computation every surface consumes (#221). Pure
 * over the muscle's band and its weekly credited set count (the fractional total
 * from `coverageFromSets`, secondary muscles already at 0.5). Boundaries are
 * INCLUSIVE on the band: exactly `low` or exactly `high` is `within`.
 */
export function bandVerdict(muscle: MuscleId, sets: number): BandVerdict {
  if (!(sets > 0)) return "untrained";
  const { low, high } = VOLUME_BANDS[muscle];
  if (sets < low) return "below";
  if (sets > high) return "above";
  return "within";
}

// ---- Shared palette (the #721 precedent: presentation beside the verdict) ---

export interface BandPresentation {
  verdict: BandVerdict;
  label: string; // short chip text
  // Hex tint for a chart/SVG surface (the #737 anatomy figure) — plain data so the
  // server list and a future client figure share ONE palette, never inventing their
  // own colors.
  color: string;
  // Tailwind classes for a DOM chip (the coverage-list badge). Kept beside the hex
  // so both DOM and SVG surfaces read the same source of truth.
  badgeClass: string;
}

const BAND_PRESENTATION: Record<BandVerdict, BandPresentation> = {
  below: {
    verdict: "below",
    label: "Below band",
    color: "#f59e0b", // amber-500 — under the effective-volume floor
    badgeClass:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  within: {
    verdict: "within",
    label: "In band",
    color: "#16a34a", // green-600 — in the effective range
    badgeClass:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  above: {
    verdict: "above",
    label: "Above band",
    color: "#0ea5e9", // sky-500 — past the adaptive ceiling (informational)
    badgeClass: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  },
  untrained: {
    verdict: "untrained",
    label: "Untrained",
    color: "#94a3b8", // slate-400 — neutral empty tint, never a "below" alarm
    badgeClass:
      "bg-slate-100 text-slate-500 dark:bg-slate-700/40 dark:text-slate-400",
  },
};

/** Presentation metadata for a verdict — the shared palette every surface renders. */
export function bandPresentation(verdict: BandVerdict): BandPresentation {
  return BAND_PRESENTATION[verdict];
}

// ---- Windows & cold-start gate (#719) --------------------------------------

// The band is a WEEKLY working-set band, so the verdict is read over the trailing
// 7-day coverage window — the same window the Overview coverage list renders.
export const VOLUME_BAND_WINDOW_DAYS = 7;

// The trailing window whose distinct training weeks the cold-start gate counts. Eight
// weeks matches getRecentDatedExercises' default recent scan, so the finding builder
// reuses that ONE gather.
export const BAND_HISTORY_WINDOW_DAYS = 56;

// A brand-new profile has "no answer yet", not "everything below target": no
// below/untrained observation fires until the profile has logged strength sessions in
// at least this many DISTINCT weeks of the trailing window (#719). Two weeks is the
// least that shows a repeated pattern rather than a single lopsided week.
export const MIN_BAND_HISTORY_WEEKS = 2;

/**
 * Count the distinct (week-start-keyed) weeks that contain at least one of the given
 * strength-session dates — the cold-start history signal. `weekStart` follows the
 * profile's week convention but the count is robust to the choice.
 */
export function countDistinctWeeks(
  dates: readonly string[],
  weekStart = 0
): number {
  const weeks = new Set<string>();
  for (const d of dates) weeks.add(startOfWeekStr(d, weekStart));
  return weeks.size;
}

// ---- Coaching-tier observation engine (#742, the training-observations style) ---

// One dedupeKey namespace for every volume-band finding, registered in
// lib/rule-finding-prefixes.ts so the #448 reflection guard covers it and a page's
// prefix-guarded dismiss action can match it.
export const MUSCLE_VOLUME_PREFIX = "muscle-volume:";

/**
 * Episodic dedupeKey (#436): a shortfall for one muscle in one calendar month. The
 * YYYY-MM anchor keeps a dismissal stuck for the rest of the month (stable across the
 * rolling weekly window) while a shortfall that persists into a NEW month re-fires as
 * a fresh episode — a dismissal is "this month's shortfall", not "this muscle forever".
 */
export function muscleVolumeSignalKey(
  muscle: MuscleId,
  monthAnchor: string
): string {
  return `${MUSCLE_VOLUME_PREFIX}below:${muscle}:${monthAnchor}`;
}

// Render a possibly-fractional set count (secondary credit is 0.5) — whole numbers
// plainly, half-credit with one decimal.
function fmtSets(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** One muscle's weekly credited set total, the shortfall engine's input. */
export interface MuscleVolumeInput {
  muscle: MuscleId;
  sets: number;
}

export interface VolumeBandObservation {
  muscle: MuscleId;
  key: string; // episodic dedupeKey
  sets: number;
  low: number;
  title: string;
  detail: string;
}

/**
 * Sustained-shortfall observations: one calm finding per muscle whose weekly volume
 * is BELOW its band floor. Deliberately scoped to `below` (a muscle you clearly train
 * but under-volume) — NOT `untrained`: with no routine/"expected sets" model yet
 * (that arrives with #738/#741) a zero-set muscle is an ordinary split rotation, not a
 * shortfall, so turning all untrained muscles into findings would be noise. Untrained
 * muscles still render neutral on the coverage list/figure; only the FINDING is held.
 *
 * TWO gates, both decided here in the ONE gather (never per surface):
 *   • Cold start (#719): below MIN_BAND_HISTORY_WEEKS distinct training weeks →
 *     emit NOTHING ("not enough data yet", never "everything below target").
 *   • Deload (#741, guarded): during an active routine's deload week the `below`
 *     observation is suppressed — the week is SUPPOSED to be light. `deloadActive`
 *     is fed by a guarded hook that is inert (always false) until #741 ships the
 *     week-in-cycle flag; the figure still shows real numbers, only the finding holds.
 *
 * Pure over its inputs; the DB gather lives in lib/rule-findings.ts. Ordered by the
 * size of the shortfall (largest gap first) for a deterministic, useful order.
 */
export function detectVolumeShortfalls(
  inputs: readonly MuscleVolumeInput[],
  opts: {
    historyWeeks: number;
    deloadActive: boolean;
    monthAnchor: string;
    // Coarse regions EXCLUDED by an ACTIVE injury (#838): a "behind on chest" volume
    // shortfall is noise while the region is out, so a muscle rolling up to an excluded
    // region emits NO finding. Absent / empty ⇒ no exclusion (the prior behavior).
    excludedRegions?: ReadonlySet<MuscleRegion>;
  }
): VolumeBandObservation[] {
  // Cold start: an unanswered question is not a negative answer.
  if (opts.historyWeeks < MIN_BAND_HISTORY_WEEKS) return [];
  // Deload week (guarded): the shortfall is expected, hold the finding.
  if (opts.deloadActive) return [];

  const excluded = opts.excludedRegions;
  const out: { obs: VolumeBandObservation; gap: number }[] = [];
  for (const { muscle, sets } of inputs) {
    // Active-injury exclusion (#838): hold the shortfall finding for an off-limits region.
    if (excluded && excluded.has(muscleRegion(muscle))) continue;
    if (bandVerdict(muscle, sets) !== "below") continue;
    const { low } = VOLUME_BANDS[muscle];
    const label = muscleLabel(muscle);
    const unit = sets === 1 ? "set" : "sets";
    out.push({
      gap: low - sets,
      obs: {
        muscle,
        key: muscleVolumeSignalKey(muscle, opts.monthAnchor),
        sets,
        low,
        title: `${label} volume is light this week`,
        detail:
          `${label}: ${fmtSets(sets)} ${unit} this week — the weekly floor for ` +
          `steady growth is about ${low}. A little more direct volume brings it ` +
          `into range.`,
      },
    });
  }
  return out.sort((a, b) => b.gap - a.gap).map((x) => x.obs);
}

/** Iterate every muscle's band (for tests / a future routine-plan band summary). */
export function allBands(): { muscle: MuscleId; band: VolumeBand }[] {
  return MUSCLE_IDS.map((muscle) => ({ muscle, band: VOLUME_BANDS[muscle] }));
}
