import { shiftDateStr } from "./date";

// Consecutive active days ending today — or yesterday, so a run you haven't
// extended yet today still reads as "current". Dates are configured-TZ YYYY-MM-DD
// strings (so day boundaries are DST-immune and match the calendar/db notion of
// "today"); `today` is the anchor date in that same form. `dates` is the set of
// active dates (order irrelevant — it's read as a set).
//
// THE ONLY REMAINING CALLER IS THE COACHING OVERTRAINING DETECTOR
// (lib/coaching/engine.ts), which asks "how many days in a row have you trained
// HARD?" and answers "a rest or light day will help you recover." That is the app
// telling you to STOP — the inverse of a run to maintain.
//
// The user-facing activity streak this module also used to serve (the rest-tolerant
// `flexibleStreak`/`activityStreak` pair, #1398) is GONE — #1935/#1936/#1937/#1939
// retired the whole run-shaped display family: the weekly-recap streak line, the
// per-supplement 🔥 chip, the Training Log "N-day streak", and the `streak:` /
// `adherence:` milestones. Each measured continuity of app-logged behavior rather
// than health, each had a CLIFF where a rate degrades gracefully, and each fought
// the machinery on the other side of the app recommending rest days, deload weeks,
// illness pauses, and deliberate skips. Consistency is still reported — as the
// rates and counts that survive (adherence %, active days, workouts) — which a
// missed day nudges instead of zeroing.
//
// So: do not reintroduce a rest-tolerant variant here to give a surface a number to
// print under the word "streak". A new caller must be answering the overtraining
// question (or another "you have done too much of this in a row" question), under
// its own label, and must register in lib/__tests__/streak-scope.test.ts.
export function currentStreak(today: string, dates: string[]): number {
  const set = new Set(dates);
  if (set.size === 0) return 0;
  // Walk back from the anchor "today" by calendar-date string (DST-immune),
  // matching the day boundaries used everywhere else. If today has no activity,
  // allow yesterday to anchor the run; otherwise there is no current run.
  let cur = today;
  if (!set.has(cur)) {
    cur = shiftDateStr(cur, -1);
    if (!set.has(cur)) return 0;
  }
  let streak = 0;
  while (set.has(cur)) {
    streak++;
    cur = shiftDateStr(cur, -1);
  }
  return streak;
}
