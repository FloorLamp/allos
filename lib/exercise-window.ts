import { daysBetweenDateStr } from "./date";
import { strengthLoadKey } from "./lifts";

// Trailing window (days) that bounds the "recent" strength-history scans AND the
// freshness of a next-set progression seed. A session or name older than this is
// irrelevant to what to suggest next, so the editor's per-exercise scan bounds
// itself to it (recentWindowStart) and getStrengthByExercise gates its seed on it.
// ONE source of the constant so the two surfaces share the same boundary by
// construction (#331).
export const RECENT_WINDOW_DAYS = 365;

/**
 * Whether the most recent session of a lift is fresh enough to SEED a next-set
 * suggestion — i.e. within RECENT_WINDOW_DAYS of `today`.
 *
 * The explicit decision for the >1yr-old-seed divergence (#331): a session older
 * than the recent window seeds a next-set suggestion on NEITHER surface. The
 * editor's getRecentExerciseHistory only scans sessions inside the window, so a
 * lift last trained >12 months ago yields no chip there; getStrengthByExercise
 * gates its lastSessionBest/lastSessionSets seed on this same predicate, so the
 * detail panel / coaching / Telegram no longer suggest off a stale year-old
 * session while the editor stays silent. Historical stats (PRs, e1RM, volume) are
 * unaffected — only the forward-looking seed is withheld.
 *
 * Same inclusive boundary as recentWindowStart (date >= today − windowDays), so
 * the seed a builder withholds is exactly the session the editor's window drops.
 */
export function isSeedFresh(
  lastDate: string,
  today: string,
  windowDays = RECENT_WINDOW_DAYS
): boolean {
  const age = daysBetweenDateStr(lastDate, today);
  return age != null && age <= windowDays;
}

// A history entry a seed may be drawn from. `equipmentId` is the session's
// `exercise_sets.equipment_id` — the registry implement it was performed on, or
// null for the unassigned/default lane. Optional so the pre-#1610 shapes (raw set
// rows without the column selected) still type-check as an all-unassigned history.
export interface SeedCandidate {
  date: string;
  exercise: string;
  equipmentId?: number | null;
}

/**
 * The sessions of a merged movement history that are LOAD-COMPARABLE with the
 * (exercise, equipment) context being entered — the ONE gate every seed, repeat-fill
 * and "Recent" reference passes through (#1610).
 *
 * Since #331 a base's equipment variants collapse under one canonical
 * exerciseHistoryKey, so `sessions` (newest-first) can interleave implements — a
 * Dumbbell Curl session and a Barbell Curl session share one history, and since a
 * profile may own several registry machines, two sessions can even share one exact
 * name and still be non-comparable loads.
 *
 * The rule, in order:
 *
 * 1. Sessions matching the requested `strengthLoadKey` (exact variant + equipment
 *    lane) win. This preserves #393's barbell-vs-dumbbell separation and adds the
 *    equipment-instance separation #1610 asks for.
 * 2. Otherwise, when EITHER side names a registry implement, return nothing. A
 *    freshly selected hotel machine must show no home-machine ghost, and a set left
 *    in the unassigned lane must not inherit a machine's numbers — we never guess
 *    which implement produced non-comparable history.
 * 3. Otherwise (an equipment-free history and an equipment-free target, e.g. an
 *    ambiguous bare base like "Curl" that was only ever logged as "Dumbbell Curl"),
 *    fall back to the whole merged history exactly as before #1610 — byte-for-byte
 *    prior behavior for every profile that owns no strength equipment.
 */
export function loadContextSessions<T extends SeedCandidate>(
  sessions: readonly T[],
  targetName: string,
  targetEquipmentId: number | null = null
): T[] {
  if (sessions.length === 0) return [];
  const want = strengthLoadKey(targetName, targetEquipmentId);
  const exact = sessions.filter(
    (s) => strengthLoadKey(s.exercise, s.equipmentId ?? null) === want
  );
  if (exact.length > 0) return exact;
  const anyTagged =
    targetEquipmentId != null ||
    sessions.some((s) => (s.equipmentId ?? null) != null);
  if (anyTagged) return []; // rule 2 — never cross a load context
  return [...sessions]; // rule 3 — legacy equipment-free fallback (#393)
}

/**
 * Pick the prior sessions that SEED a next-set suggestion for the
 * (`targetName`, `targetEquipmentId`) load context out of a lift's merged history.
 *
 * Narrows the history to its load-comparable slice (loadContextSessions above), then
 * keeps that slice's newest date — two same-day activities are one session, as
 * everywhere in the strength layer — for the caller to flatMap into the seed. ONE
 * decision the editor chip, getStrengthByExercise's lastSessionBest/lastSessionSets
 * and the session recap's vs-last delta all consume, so the seed is
 * implement-appropriate identically on every surface.
 *
 * Generic over `{ date, exercise, equipmentId? }` so it serves both the editor's
 * RecentSession objects and getStrengthByExercise's raw set rows.
 */
export function pickSeedSessions<T extends SeedCandidate>(
  sessions: readonly T[],
  targetName: string,
  targetEquipmentId: number | null = null
): T[] {
  const comparable = loadContextSessions(
    sessions,
    targetName,
    targetEquipmentId
  );
  if (comparable.length === 0) return [];
  // `sessions` arrives newest-first, and the filters above preserve that order.
  const newestDate = comparable[0].date;
  return comparable.filter((s) => s.date === newestDate);
}
