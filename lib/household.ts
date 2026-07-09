// Pure card-assembly logic for the admin household dashboard (issue #102). No DB
// or network access — the page fetches each profile's data with the existing
// per-profile query functions (in a loop over getAccessibleProfiles) and hands
// the raw results to these helpers, so the cross-profile view is built without
// any new cross-profile SQL and the logic stays unit-testable.

import { isDueOn } from "./supplement-schedule";
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
  doses: { id: number; supplement_id: number }[],
  activeSuppById: Map<number, Pick<Supplement, "condition" | "situation">>,
  ctx: { isWorkoutDay: boolean; activeSituations: Set<string> },
  takenDoseIds: Set<number>
): Adherence {
  let due = 0;
  let taken = 0;
  for (const dose of doses) {
    const supp = activeSuppById.get(dose.supplement_id);
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

// Percent-complete for a goal, mirroring the dashboard's rule: exercise-linked
// and body-metric goals use their derived progress (0 when not yet computed);
// manual goals with a numeric target use current/target (capped at 100); goals
// with no numeric basis have no percentage.
export function goalPct(g: Goal, progress?: GoalProgress): number | null {
  if (g.metric || g.body_metric) return progress?.pct ?? 0;
  if (g.target_value && g.current_value != null)
    return Math.min(100, Math.round((g.current_value / g.target_value) * 100));
  return null;
}

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
