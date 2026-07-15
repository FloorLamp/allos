// Mesocycle & deload awareness on routines (#741, Pillar 4b of the workout-UX
// epic #732). Pure and client-safe — no DB/network — so the week-in-cycle math
// runs in components and under test.
//
// A routine may declare an optional, user-owned `cycle_weeks` (NULL ⇒ no cycle,
// all current behavior). The LAST week of the cycle is the deload week by
// convention. Week-in-cycle is CALENDAR-derived from the routine's effective
// start; #559 governs the whole feature — the cycle is a counter the USER set,
// never a readiness model, so nothing here infers a deload from fatigue.
//
// The subtlety is PAUSES. Naive `started_date` arithmetic resumes a returning
// user into an arbitrary — possibly deload — week: activate a routine, take a
// three-week break, come back, and the calendar says "deload week" though you
// just detrained. So the effective start RE-ANCHORS across a long gap in credited
// sessions (below), and is derived deterministically from logged data — no hidden
// write on a read path.

import { daysBetweenDateStr } from "./date";

// A gap of this many days or more with NO credited session re-anchors the cycle:
// three weeks off is a detraining break, not a mid-cycle rest, so the returner
// restarts at week 1 rather than resuming wherever the naive calendar landed. Set
// generously so an ordinary deload week or a skipped week never trips it.
export const CYCLE_PAUSE_GAP_DAYS = 21;

// The effective cycle start — the anchor `weekInCycle` counts from. Starts at the
// routine's `startedDate` and RE-ANCHORS forward across every long pause: a gap of
// CYCLE_PAUSE_GAP_DAYS+ days with no credited session moves the anchor to the first
// credited session AFTER the gap. An ongoing pause (no session for that long, right
// up to `today`) anchors to `today`, so a user who just came back is in week 1 even
// before logging their first session. `creditedDates` are the #740 credited-session
// dates (from sessionCreditsDay), passed in — this stays a pure calendar function.
//
// Deterministic from the inputs; the same (startedDate, creditedDates, today)
// always yields the same anchor, so no surface needs to persist it.
export function effectiveCycleStart(
  startedDate: string,
  creditedDates: readonly string[],
  today: string
): string {
  // Only sessions on/after the start and up to today bound the cycle. Sort + dedup
  // so the walk sees a clean monotone sequence regardless of input order.
  const sessions = [...new Set(creditedDates)]
    .filter((d) => d >= startedDate && d <= today)
    .sort();

  let anchor = startedDate;
  let prev = startedDate;
  for (const d of sessions) {
    const gap = daysBetweenDateStr(prev, d);
    // A ≥CYCLE_PAUSE_GAP_DAYS gap ending at session `d` is a detraining break the
    // user returned from — restart the cycle at `d`.
    if (gap != null && gap >= CYCLE_PAUSE_GAP_DAYS) anchor = d;
    prev = d;
  }
  // Trailing/ongoing pause: no credited session for CYCLE_PAUSE_GAP_DAYS+ days up to
  // today (including the never-trained-yet case, where prev is still startedDate) ⇒
  // the user is mid-break, so anchor to today (week 1 the moment they resume).
  const trailing = daysBetweenDateStr(prev, today);
  if (trailing != null && trailing >= CYCLE_PAUSE_GAP_DAYS) anchor = today;

  return anchor;
}

// The 0-based week within the cycle: floor(daysSince(effectiveStart)/7) % cycleWeeks.
// A future/invalid effectiveStart (or today before it) clamps to week 0. `cycleWeeks`
// is the caller's validated positive length.
export function weekInCycle(
  effectiveStart: string,
  today: string,
  cycleWeeks: number
): number {
  if (cycleWeeks <= 0) return 0;
  const days = daysBetweenDateStr(effectiveStart, today);
  if (days == null || days < 0) return 0;
  return Math.floor(days / 7) % cycleWeeks;
}

// Whether `week` is the deload week — the LAST week of the cycle. A 1-week "cycle"
// has no distinct deload (every week would be one), so a deload requires
// cycleWeeks ≥ 2; a user who wants deloads sets a real multi-week cycle.
export function isDeloadWeek(week: number, cycleWeeks: number): boolean {
  return cycleWeeks >= 2 && week === cycleWeeks - 1;
}

// Whole weeks from `week` until the cycle's deload week (its last week). 0 when
// this IS the deload week. Used to phrase the plateau finding's cross-reference
// (#741: "a deload week is ≤2 weeks away") — the count is always in [0, cycleWeeks).
export function weeksUntilDeload(week: number, cycleWeeks: number): number {
  if (cycleWeeks < 2) return 0;
  const deloadWeek = cycleWeeks - 1;
  return week <= deloadWeek ? deloadWeek - week : 0;
}
