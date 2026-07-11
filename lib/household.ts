// Pure card-assembly logic for the household dashboard (issue #31). No DB
// or network access — the page fetches each profile's data with the existing
// per-profile query functions (in a loop over getAccessibleProfiles) and hands
// the raw results to these helpers, so the cross-profile view is built without
// any new cross-profile SQL and the logic stays unit-testable.

import { isDueOn } from "./supplement-schedule";
import { goalPct } from "./goals";
import type { Goal, Supplement } from "./types";
import type { GoalProgress } from "./goal-progress";

// ---- Supplement adherence (today) ----

export interface Adherence {
  taken: number;
  due: number;
}

// x/y supplement adherence for a single day: how many of today's due doses have
// been logged. A dose counts as "due" when its (active) parent supplement is due
// under today's context (workout/rest/situational — the same isDueOn used by the
// supplements page and the notifier). Doses whose supplement is missing from
// `activeSuppById` (inactive/deleted) are skipped.
export function supplementAdherenceToday(
  doses: { id: number; item_id: number }[],
  activeSuppById: Map<number, Pick<Supplement, "condition" | "situation">>,
  ctx: { isWorkoutDay: boolean; activeSituations: Set<string> },
  takenDoseIds: Set<number>
): Adherence {
  let due = 0;
  let taken = 0;
  for (const dose of doses) {
    const supp = activeSuppById.get(dose.item_id);
    if (!supp) continue;
    if (!isDueOn(supp, ctx)) continue;
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
}

// The active, non-archived goals to surface on a profile's household card, in
// the order getGoals already returns them (active first), capped at `limit`.
export function goalHighlights(
  goals: Goal[],
  progress: Map<number, GoalProgress>,
  limit = 2
): GoalHighlight[] {
  return goals
    .filter((g) => g.status === "active" && !g.archived)
    .slice(0, limit)
    .map((g) => ({
      id: g.id,
      title: g.title,
      pct: goalPct(g, progress.get(g.id)),
    }));
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
// scheduled_at ASC, id ASC gets the earliest same-day slot. Generic over `{ dueDate }`
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
