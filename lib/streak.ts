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

// Rest-tolerant "flexible" streak: the number of ACTIVE days in the current run,
// allowing up to `restDaysAllowed` consecutive rest days between (and before)
// active days without breaking the run. This is the habit-friendly counterpart to
// currentStreak, which dies on the first empty day — so a Mon/Wed/Fri rhythm keeps
// a live streak here but reads as just "1" under the strict rule.
//
// Design note — rest-day tolerance was chosen over a fixed "N active days per
// rolling window" rule because it (a) returns a value in the SAME unit as
// currentStreak (a day count), (b) needs no window/threshold tuning, and (c)
// degrades EXACTLY to currentStreak's currency anchoring at restDaysAllowed = 1
// (only today or yesterday can anchor a live streak). We count active days rather
// than the calendar span so trailing/leading rest days never inflate the number
// and it's always ≥ 0 and easy to reason about (and always ≥ currentStreak).
export function flexibleStreak(
  today: string,
  dates: string[],
  restDaysAllowed = 1
): number {
  const set = new Set(dates);
  if (set.size === 0) return 0;
  let cur = today;
  let streak = 0;
  let rest = 0;
  // Walk back day-by-day. An active day extends the streak and resets the rest
  // counter; an empty day spends one day of tolerance. More than `restDaysAllowed`
  // empty days in a row ends the run — which also enforces currency: if the most
  // recent active day is more than restDaysAllowed back from today, the run is 0.
  // Terminates because `cur` strictly decreases past the earliest active date.
  while (true) {
    if (set.has(cur)) {
      streak++;
      rest = 0;
    } else if (++rest > restDaysAllowed) {
      break;
    }
    cur = shiftDateStr(cur, -1);
  }
  return streak;
}

// THE user-facing activity streak (issue #1398 / #221: one question, one computation).
//
// Both variants above are legitimate math, but only ONE of them may answer the
// question a surface labels "streak". Two engines used to feed that one word — the
// Training week tile read the strict currentStreak while the milestone and the
// weekly recap read the rest-tolerant flexibleStreak — so a profile could earn a
// "30-day activity streak" recognition while the Training tile read "Streak 2".
//
// The rest-tolerant variant wins: it is the one the recognition surfaces already
// celebrate, and a training habit that includes rest days is a habit kept, not a
// habit broken. Every surface that shows the user a number under the word "streak"
// (the Training/Journal week summary, the milestone engine, the weekly recap card
// and notification) calls THIS function — never flexibleStreak or currentStreak
// directly — so the variant can never be re-picked per surface.
//
// currentStreak stays exported for the DIFFERENTLY-LABELLED consecutive-day count:
// the weekly recap's "N-day consecutive" delta and the coaching overtraining nudge's
// "trained N days in a row" (which additionally asks about hard-session dates, not
// activity dates). Distinct question, distinct label, distinct number.
export function activityStreak(today: string, dates: string[]): number {
  return flexibleStreak(today, dates);
}
