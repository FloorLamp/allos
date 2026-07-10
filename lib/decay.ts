import { daysBetweenDateStr } from "./date";

// Half-life (in days) for recency-decayed activity-suggestion frequency
// (issue #195): a lift logged today weighs 1.0, ~60 days ago 0.5, and roughly a
// year ago only a few percent — so a recent habit outranks a stale one even
// when the stale one has more total logs.
export const SUGGESTION_HALF_LIFE_DAYS = 60;

// Exponential recency weight for an occurrence dated `date`, relative to
// `today` (both YYYY-MM-DD). 1.0 on the same day, halving every `halfLifeDays`.
// A future date (a scheduled/edited row) or an unparseable date clamps to 1.0 —
// nothing should weigh MORE than today, and a bad date shouldn't silently
// vanish from the ranking.
export function decayedWeight(
  date: string,
  today: string,
  halfLifeDays = SUGGESTION_HALF_LIFE_DAYS
): number {
  const ago = daysBetweenDateStr(date, today);
  if (ago == null || ago <= 0) return 1;
  return Math.pow(0.5, ago / halfLifeDays);
}
