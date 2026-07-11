import { daysBetweenDateStr } from "./date";

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
