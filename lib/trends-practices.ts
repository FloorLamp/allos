// Trends' practice window and digest series (issue #1632) — the pure layer. The
// digest reads a practice's completed-week ledger over the hub's window; the
// decisions that read needs live here so they are unit-tested rather than inlined
// on a Server Component. Practice findings are coaching-tier (calm, hideable), so
// nothing in here is an attention signal.

import { lensWindow, type LensWeekCaps } from "./trends";

// ---------------------------------------------------------------------------
// How much history the hub's window is worth
// ---------------------------------------------------------------------------

// Below about a month of columns a weekly strip has too few cells to read as
// consistency at all, so a very short window still draws a month of context —
// the same floor the Fitness lens applies to its weekly charts.
export const MIN_PRACTICE_TREND_WEEKS = 4;
// Half a year of columns stays scannable on a phone without horizontal scroll and
// bounds an "All time" window.
export const MAX_PRACTICE_TREND_WEEKS = 26;

// This lens's week-column caps. Only the CAPS are the lens's own decision; the
// anchor rule that turns a DateRange into a window is `lensWindow`, shared with
// Fitness (#2043).
export const PRACTICE_WEEK_CAPS: LensWeekCaps = {
  minWeeks: MIN_PRACTICE_TREND_WEEKS,
  maxWeeks: MAX_PRACTICE_TREND_WEEKS,
};

export interface PracticeTrendWindow {
  /** The day the completed-week ledger is anchored on. */
  asOf: string;
  /** How many completed weeks before that day to read. */
  weeks: number;
}

// Resolve the hub's shared DateRange into what the lens actually needs. Two
// decisions, both of them the honest reading of a windowed surface:
//
//   • The ANCHOR is the range's end, clamped to today — a window ending last
//     month should show the weeks that ended then, not the weeks that ended now.
//   • The LENGTH is the window's span in weeks, clamped. An open-ended ("All
//     time") range takes the cap.
//
// Both now come from the hub-wide `lensWindow` (#2043); this is the projection
// onto the two fields the completed-week ledger reads.
export function practiceTrendWindow(
  range: { from?: string; to?: string },
  todayStr: string
): PracticeTrendWindow {
  const window = lensWindow(range, todayStr, PRACTICE_WEEK_CAPS);
  return { asOf: window.to, weeks: window.weeks };
}

// ---------------------------------------------------------------------------
// The digest series
// ---------------------------------------------------------------------------

// The digest's key namespace for a practice cadence series. Deliberately NOT the
// `practice:<targetId>` signal key from lib/practice.ts — that one is a
// suppression identity shared by Upcoming and the Telegram nudge, and a digest
// chip is a different (dismissible-on-its-own) thing.
export const PRACTICE_DIGEST_PREFIX = "wellness:";

export function practiceDigestKey(identity: string): string {
  return `${PRACTICE_DIGEST_PREFIX}${identity}`;
}

// A practice's cadence has to move a LOT to be worth a digest chip. The default
// 5% bar is meaningless on a series whose values are small integers — one extra
// sauna in a 3×/week habit is already 33% — so the lens sets its own third-of-a-
// cadence bar, and requires enough completed weeks for the move to be a trend.
export const PRACTICE_DIGEST_MIN_CHANGE = 0.34;
export const PRACTICE_DIGEST_MIN_WEEKS = 4;

// Whether a practice's completed-week ledger is even eligible for a digest chip:
// it must be a TRACKED practice (a cadence the user declared — an untracked
// practice's session count moving is not a commitment moving) with enough
// completed weeks, and it must have actually happened at least once.
export function practiceDigestEligible(input: {
  perWeek: number | null;
  weeks: readonly { count: number }[];
}): boolean {
  if (input.perWeek == null) return false;
  if (input.weeks.length < PRACTICE_DIGEST_MIN_WEEKS) return false;
  return input.weeks.some((w) => w.count > 0);
}
