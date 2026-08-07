// Pure card-assembly logic for the household dashboard (issue #31). No DB
// or network access — the page fetches each profile's data with the existing
// per-profile query functions (in a loop over getAccessibleProfiles) and hands
// the raw results to these helpers, so the cross-profile view is built without
// any new cross-profile SQL and the logic stays unit-testable.

import { doseDueOn, type IntakeDayContext } from "./supplement-schedule";
import type { DoseCadence, ItemCadence } from "./intake-cadence";
import { goalBarClass, goalPct, isGoalLive } from "./goals";
import type { Goal, Supplement } from "./types";
import type { GoalProgress } from "./goal-progress";

// ---- Supplement adherence (today) ----

export interface Adherence {
  taken: number;
  due: number;
}

// x/y intake adherence for a single day: how many of today's due doses have been
// logged. A dose counts as "due" when its (active) parent item is due under today's
// context (workout/rest/situational — the same isDueOn used by the supplements page
// and the notifier). Doses whose item is missing from `activeSuppById`
// (inactive/deleted) are skipped.
//
// `may` items are absent from this fraction, and that is the point of #1505 rather
// than an omission: a may item has no dueness, so it has no denominator to be part
// of and cannot drag an honest number down. It comes for free — isDueOn short-
// circuits on `may` — which is why the obligation must be in the Pick.
export function supplementAdherenceToday(
  doses: (DoseCadence & { id: number; item_id: number })[],
  activeSuppById: Map<
    number,
    Pick<Supplement, "condition" | "situation" | "obligation"> & ItemCadence
  >,
  ctx: IntakeDayContext,
  takenDoseIds: Set<number>
): Adherence {
  let due = 0;
  let taken = 0;
  for (const dose of doses) {
    const supp = activeSuppById.get(dose.item_id);
    if (!supp) continue;
    // doseDueOn, not isDueOn: an off-cadence day and an out-of-window dose row must
    // leave the DENOMINATOR alone too (#1602). A weekly med counted as due every day
    // would read 1/7 on a perfectly-followed week — the same dishonest fraction the
    // `may` short-circuit exists to prevent, arriving through the calendar instead.
    if (!doseDueOn(supp, dose, ctx)) continue;
    due++;
    if (takenDoseIds.has(dose.id)) taken++;
  }
  return { taken, due };
}

// ---- Weight trend ----

export type TrendDir = "up" | "down" | "flat";

export interface WeightTrend {
  dir: TrendDir;
  // Signed change latest − previous, in kg (the canonical storage unit).
  deltaKg: number;
}

// Direction of the most recent weight change, from the two newest weigh-ins
// (latest first). Null when there aren't two readings to compare. A change
// smaller than `tolKg` reads as "flat" so day-to-day noise doesn't render as a
// trend arrow.
export function weightTrend(
  latestKg: number | null | undefined,
  previousKg: number | null | undefined,
  tolKg = 0.1
): WeightTrend | null {
  if (latestKg == null || previousKg == null) return null;
  const deltaKg = latestKg - previousKg;
  if (Math.abs(deltaKg) < tolKg) return { dir: "flat", deltaKg };
  return { dir: deltaKg > 0 ? "up" : "down", deltaKg };
}

// ---- Goal highlights ----

export interface GoalHighlight {
  id: number;
  title: string;
  pct: number | null;
  // Pre-resolved pace-verdict bar tint (#780), so the client card formats over the
  // SAME shared tone→class map as every other goal bar without threading dates.
  // Empty when pct is null (no bar rendered).
  barClass: string;
}

// The active, non-archived goals to surface on a profile's household card, in
// the order getGoals already returns them (active first), capped at `limit`.
// `today` (YYYY-MM-DD) is the pace clock for each goal's deadline window (#780).
export function goalHighlights(
  goals: Goal[],
  progress: Map<number, GoalProgress>,
  today: string,
  limit = 2
): GoalHighlight[] {
  return goals
    .filter((g) => isGoalLive(g))
    .slice(0, limit)
    .map((g) => {
      const pct = goalPct(g, progress.get(g.id));
      return {
        id: g.id,
        title: g.title,
        pct,
        barClass:
          pct == null
            ? ""
            : goalBarClass(pct, {
                createdAt: g.created_at,
                targetDate: g.target_date,
                today,
              }),
      };
    });
}

// ---- Household rollup (issue #31) ----

// The single "next appointment" pick, shared by BOTH the dashboard needs-attention
// hero and the household card so they can never disagree (issue #303 — they used to
// run independent pickers with opposite overdue policies). Policy: the most
// attention-worthy scheduled visit — soonest by calendar date, so a still-scheduled
// PAST visit (overdue/unlogged, worth chasing — the same "Overdue" framing the
// Upcoming banding uses) sorts ahead of a future one, and the nearest future visit
// wins when none are overdue. Items missing a dueDate sort last (treated as far
// future) so a dated visit always wins; null for an empty list. Ties (same calendar
// day) keep the first item, so a caller that feeds appointments already ordered by
// date ASC, time_of_day ASC, id ASC gets the earliest same-day slot. Generic over `{ dueDate }`
// so the household UpcomingItem set and the dashboard's raw scheduled-appointment set
// resolve to the identical row (see the fixture-parity test). Kept here (not inline in
// the DB helper) so it stays unit-tested.
export function pickNextAppointment<T extends { dueDate: string | null }>(
  items: T[]
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null) {
      best = item;
      continue;
    }
    const a = item.dueDate ?? "9999-12-31";
    const b = best.dueDate ?? "9999-12-31";
    if (a < b) best = item;
  }
  return best;
}
