// Steps-today summary (issue #1221, dashboard daily-loop): the ONE pure aggregation
// behind the Steps-today dashboard card — today's step count against the prior
// seven days. No DB/clock: the gather (getMetricDailyTotals(profileId, "steps"))
// hands the deduped one-source-per-day series here, so the card is a thin formatter
// over this result (#221). Deliberately a FLOOR-free plain read — steps are an
// additive metric already deduped to one source per day upstream (#14).
//
// The baseline itself is NOT computed here: it is `trailingAverage` (#1909), the one
// trailing-average implementation, asked for its data-bearing basis with today
// excluded. Only the rounding is local — a step count is a whole number.

import { trailingAverage } from "./trailing-average";

export type StepsDirection = "up" | "down" | "flat";

export interface StepsTodaySummary {
  // Today's steps, or null when no step reading is recorded for today yet (the card
  // then reads "No steps logged yet today" alongside the trailing average).
  today: number | null;
  // The mean of up to the 7 most recent days STRICTLY BEFORE today that carry a
  // reading, rounded to a whole step. Null when no prior day has data — including
  // the day-one case, where the shared helper offers today's reading and this card
  // declines it (see summarizeStepsToday).
  average7: number | null;
  // today − average7 as a signed percentage of the average, rounded; null unless both
  // figures are present AND the day is complete enough to compare (see
  // STEPS_DELTA_COMPLETE_HOUR).
  deltaPct: number | null;
  // Direction of today vs the trailing average; null on the same terms as deltaPct,
  // because it answers the same comparison and cannot be honest when that one is not.
  // NOTE it currently has NO renderer — only tests read it — so gating it changed
  // nothing a person sees. It is kept, and gated, because the day it gains one the
  // partial-day arrow would be the same false signal deltaPct was.
  direction: StepsDirection | null;
}

// The trailing window the average spans (days before today, data-bearing only).
export const STEPS_TRAILING_DAYS = 7;

// The PROFILE-LOCAL HOUR (0..23) from which today's running total may be compared
// against complete days (#3258). `today` is a partial sum and `average7` a mean of
// whole days, so before it the percentage was arithmetic about the clock: −100% every
// morning, climbing until bedtime — one unchanged day read −73% at midday and −47%
// that evening.
//
// 20, not lib/steps-target's STEPS_AFTERNOON_HOUR (16): that gates a different claim
// ("under HALF a declared target with the afternoon gone"), where the half-target
// fraction is what makes 4pm defensible. Here the claim is a whole-day total against
// whole-day totals, so only the day being nearly over makes the two comparable.
export const STEPS_DELTA_COMPLETE_HOUR = 20;

// Summarize a per-day steps series (ascending by date) against a capture date. Returns
// null only when the series is empty (the card's data-aware empty state). A series with
// history but no today reading returns { today: null, average7 } so the card still shows
// the trailing average.
export function summarizeStepsToday(
  points: readonly { date: string; value: number }[],
  todayStr: string,
  // The profile-LOCAL hour right now, or null when the caller has no clock (or wants
  // no delta). Required rather than optional so every call site declares which it is —
  // a defaulted hour would silently restore the partial-vs-complete comparison.
  localHour: number | null
): StepsTodaySummary | null {
  if (points.length === 0) return null;

  const todayRow = points.find((p) => p.date === todayStr);
  const today = todayRow ? Math.round(todayRow.value) : null;

  const trailing = trailingAverage(points, todayStr, {
    days: STEPS_TRAILING_DAYS,
    basis: "data-bearing",
  });
  // The day-one fallback is DECLINED here, by name (#1909 follow-up). The helper
  // offers today's reading when there is no complete-day history at all, so a card
  // whose only number would be today's still has something to show. This card's
  // question is "today versus my PRIOR days" — today's own count cannot be the
  // baseline today is measured against, and taking it would render "Prior 7 days ·
  // 8,432" and "0% vs prior 7 days" on the day of a first sync. Today's count is
  // already this card's headline, so nothing is hidden by leaving the baseline out.
  const average7 =
    trailing.average == null || trailing.dayOneFallback
      ? null
      : Math.round(trailing.average);

  let deltaPct: number | null = null;
  let direction: StepsDirection | null = null;
  // A veto, ahead of the value clauses: at any count, a partial total is not comparable.
  const comparable =
    localHour != null && localHour >= STEPS_DELTA_COMPLETE_HOUR;
  if (comparable && today != null && average7 != null) {
    if (average7 > 0) {
      deltaPct = Math.round(((today - average7) / average7) * 100);
      direction = today > average7 ? "up" : today < average7 ? "down" : "flat";
    } else {
      // average is zero — any positive today is "up", else flat.
      deltaPct = today > 0 ? 100 : 0;
      direction = today > 0 ? "up" : "flat";
    }
  }

  return { today, average7, deltaPct, direction };
}
