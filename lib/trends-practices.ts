// Trends' WELLNESS-PRACTICE lens (issue #1632) — the pure layer.
//
// Practices are dated one-tap logs against a weekly min–max RANGE. Every other
// surface already answers "how am I doing THIS week" (the /wellness card, the
// Goals-and-habits widget, Upcoming, the Telegram nudge); nothing answered "how
// consistent has this actually been". This module owns the decisions that second
// question needs, so they are unit-tested rather than inlined on a Server
// Component — and, critically, so they FORMAT the practice domain's existing
// verdicts instead of re-deriving them (#221).
//
// The one computation it formats is `frequencyRangeState` from lib/practice.ts —
// the same function the card, the widget, Upcoming and the nudge key on. A
// COMPLETED week is simply that state evaluated with the week fully elapsed, so a
// week the card called "met" can never read "under floor" here.
//
// Nothing in here is an attention signal. Practice findings are coaching-tier
// (calm, hideable), so the vocabulary below is deliberately verdict-neutral: the
// at-ceiling state is a SUCCESS ("that's plenty", #1259), never a red flag, and an
// under-floor week is a fact, not a nag.

import { cadenceVerdict, cadenceWeekMet, type FloorVerdict } from "./cadence";
import { clampLensWeeks, lensWindow, type LensWeekCaps } from "./trends";

// ---------------------------------------------------------------------------
// The weekly verdict
// ---------------------------------------------------------------------------

// What one COMPLETED week says about a practice. Three states, exactly the ones
// the range model already has:
//   • "at-ceiling" — the week reached the optional weekly maximum. A calm done.
//   • "met"        — the floor was cleared (and there was no ceiling to reach).
//   • "under"      — the floor was not cleared.
// `at-ceiling` implies `met` (a valid cadence always has ceiling > floor), so the
// met COUNT includes both.
// Since #2034 this IS the cadence ledger's floor-direction verdict set, not a
// parallel vocabulary that happens to have the same three members.
export type PracticeWeekVerdict = FloorVerdict;

// The verdict for a COMPLETED week. `elapsedDays` is 7 because the week is over —
// which is exactly why the pace half of frequencyRangeState collapses to
// met-or-behind here and the verdict can be stated in three words.
export function practiceWeekVerdict(
  count: number,
  floor: number,
  ceiling: number | null
): PracticeWeekVerdict {
  return cadenceVerdict({
    direction: "floor",
    count,
    target: floor,
    ceiling,
    elapsedDays: 7,
  }) as PracticeWeekVerdict;
}

// Whether a verdict cleared the week's floor. `at-ceiling` counts: it is the range
// model's most-complete state, not a separate failure mode.
export function practiceWeekMet(verdict: PracticeWeekVerdict): boolean {
  return cadenceWeekMet(verdict);
}

// Short, calm labels for the strip legend and each cell's accessible name.
export const PRACTICE_VERDICT_LABEL: Record<PracticeWeekVerdict, string> = {
  "at-ceiling": "At weekly maximum",
  met: "Floor met",
  under: "Under floor",
};

// ---------------------------------------------------------------------------
// Consistency over the window
// ---------------------------------------------------------------------------

// Consistency is a RATE over the window, never a run (#1966). A rate degrades
// gracefully where a run has a cliff, and the cliff would land on exactly the
// weeks this app exists to accommodate — an illness, a travel week, a deliberate
// pause. One under-floor week nudges "3 of 4"; it used to zero an "N-week
// streak" that a genuine habit had earned.
export interface PracticeConsistency {
  /** Completed weeks considered. */
  weeks: number;
  /** Weeks whose floor was cleared (including at-ceiling weeks). */
  met: number;
  /** met / weeks, or null when there are no completed weeks. */
  rate: number | null;
}

// Roll a practice's completed weeks (OLDEST FIRST, the render order of the strip)
// into the consistency headline. Deliberately a count of weeks rather than of
// sessions: the question is "how often did this actually happen the way I meant
// it to", and the range model answers that per week.
//
// Order-independent by construction, which is the point: no cell in the ledger
// counts for more than any other because of where it sits in the run.
export function summarizePracticeWeeks(
  weeks: readonly { verdict: PracticeWeekVerdict }[]
): PracticeConsistency {
  let met = 0;
  for (const week of weeks) {
    if (practiceWeekMet(week.verdict)) met += 1;
  }
  return {
    weeks: weeks.length,
    met,
    rate: weeks.length === 0 ? null : met / weeks.length,
  };
}

// The consistency sentence every practice card in the lens shows. One phrasing so
// the strip caption, the chart note and any later surface cannot drift.
export function practiceConsistencyText(c: PracticeConsistency): string {
  if (c.weeks === 0) return "No completed weeks yet";
  return `Floor met in ${c.met} of ${c.weeks} completed ${
    c.weeks === 1 ? "week" : "weeks"
  }`;
}

// ---------------------------------------------------------------------------
// How much history the hub's window is worth
// ---------------------------------------------------------------------------

// Below about a month of columns a weekly strip has too few cells to read as
// consistency at all, so a very short window still draws a month of context —
// the same floor the Fitness lens applies to its weekly charts.
export const MIN_PRACTICE_TREND_WEEKS = 4;
// Half a year of columns stays scannable on a phone without horizontal scroll and
// bounds an "All time" window; the full ledger lives on /wellness.
export const MAX_PRACTICE_TREND_WEEKS = 26;

// This lens's week-column caps. Only the CAPS are the lens's own decision; the
// anchor rule that turns a DateRange into a window is `lensWindow`, shared with
// Fitness (#2043).
export const PRACTICE_WEEK_CAPS: LensWeekCaps = {
  minWeeks: MIN_PRACTICE_TREND_WEEKS,
  maxWeeks: MAX_PRACTICE_TREND_WEEKS,
};

// How many COMPLETED weeks a window is worth. 90D (the hub default) → 13.
export function practiceTrendWeeks(days: number | null): number {
  return clampLensWeeks(days, PRACTICE_WEEK_CAPS);
}

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

// How many practice cards the lens renders before deferring to /wellness. The
// lens is a scannable summary on a shared landing surface, not the domain's home:
// each card carries two charts, so an unbounded list would out-weigh the census
// beneath it.
export const MAX_PRACTICE_TREND_CARDS = 6;

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
