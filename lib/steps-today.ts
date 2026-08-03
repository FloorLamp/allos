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
  // figures are present.
  deltaPct: number | null;
  // Direction of today vs the trailing average; null unless both figures are present.
  direction: StepsDirection | null;
}

// The trailing window the average spans (days before today, data-bearing only).
export const STEPS_TRAILING_DAYS = 7;

// Summarize a per-day steps series (ascending by date) against a capture date. Returns
// null only when the series is empty (the card's data-aware empty state). A series with
// history but no today reading returns { today: null, average7 } so the card still shows
// the trailing average.
export function summarizeStepsToday(
  points: readonly { date: string; value: number }[],
  todayStr: string
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
  if (today != null && average7 != null && average7 > 0) {
    deltaPct = Math.round(((today - average7) / average7) * 100);
    direction = today > average7 ? "up" : today < average7 ? "down" : "flat";
  } else if (today != null && average7 != null) {
    // average is zero — any positive today is "up", else flat.
    deltaPct = today > 0 ? 100 : 0;
    direction = today > 0 ? "up" : "flat";
  }

  return { today, average7, deltaPct, direction };
}
