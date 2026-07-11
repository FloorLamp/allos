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

/**
 * Pick the prior sessions that SEED a next-set suggestion for `targetName` out of
 * a lift's merged history.
 *
 * Since #331 a base's equipment variants collapse under one canonical
 * exerciseHistoryKey, so the merged `sessions` (newest-first) can interleave
 * implements — a Dumbbell Curl session and a Barbell Curl session share one
 * history. Seeding blindly off the newest session then mixes implements: a
 * per-hand dumbbell load and a barbell total are materially different
 * progressions (#393). This mirrors the editor's lastEquipmentId: prefer the
 * newest session logged under the EXACT `targetName`, and only when that exact
 * name was never logged fall back to the newest session overall.
 *
 * Two same-day activities are one session (as everywhere in the strength layer),
 * so the return is every session sharing the chosen session's date — filtered to
 * the exact name when an exact match won, or any implement in the fallback — for
 * the caller to flatMap into the seed. ONE decision both the editor chip and
 * getStrengthByExercise's lastSessionBest/lastSessionSets consume, so the seed is
 * implement-appropriate identically on every surface.
 *
 * Generic over `{ date, exercise }` so it serves both the editor's RecentSession
 * objects and getStrengthByExercise's raw set rows.
 */
export function pickSeedSessions<T extends { date: string; exercise: string }>(
  sessions: readonly T[],
  targetName: string
): T[] {
  if (sessions.length === 0) return [];
  const exact = targetName.trim().toLowerCase();
  const match = sessions.find((s) => s.exercise.trim().toLowerCase() === exact);
  if (match) {
    // Exact-variant history exists: seed from that variant's newest session
    // (all same-day rows of the same implement), never a heavier/lighter sibling.
    return sessions.filter(
      (s) => s.date === match.date && s.exercise.trim().toLowerCase() === exact
    );
  }
  // The exact name was never logged (e.g. an ambiguous bare base) — fall back to
  // the newest session's date, any implement, exactly as before the exact-match
  // preference existed.
  const newestDate = sessions[0].date;
  return sessions.filter((s) => s.date === newestDate);
}
