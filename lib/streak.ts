import { shiftDateStr } from "./date";

// Consecutive active days ending today — or yesterday, so a streak you haven't
// extended yet today still reads as "current". Dates are configured-TZ YYYY-MM-DD
// strings (so day boundaries are DST-immune and match the calendar/db notion of
// "today"); `today` is the anchor date in that same form. `datesDesc` is the set
// of active dates (order irrelevant — it's read as a set).
export function currentStreak(today: string, dates: string[]): number {
  const set = new Set(dates);
  if (set.size === 0) return 0;
  // Walk back from the anchor "today" by calendar-date string (DST-immune),
  // matching the day boundaries used everywhere else. If today has no activity,
  // allow yesterday to anchor the streak; otherwise there is no current streak.
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
