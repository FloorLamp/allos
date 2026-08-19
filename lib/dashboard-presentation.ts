// Pure presentation helpers shared by atomic dashboard renderers.

import { DATA_QUALITY_PREFIX } from "./data-quality";
import { FINDING_DASHBOARD_RELEVANCE } from "./findings";

export const COACHING_OBSERVATIONS_RELEVANCE_THRESHOLD =
  FINDING_DASHBOARD_RELEVANCE.review;

export function coachingObservationRelevance(finding: {
  tone?: string;
  dashboardRelevance?: number;
}): number {
  if (finding.dashboardRelevance != null) return finding.dashboardRelevance;
  return finding.tone === "caution" || finding.tone === "action"
    ? FINDING_DASHBOARD_RELEVANCE.review
    : FINDING_DASHBOARD_RELEVANCE.supporting;
}

export function isDataQualityDashboardFinding(finding: {
  dedupeKey: string;
}): boolean {
  return finding.dedupeKey.startsWith(DATA_QUALITY_PREFIX);
}

export function coachingObservationFindings<
  T extends {
    dedupeKey: string;
    tone?: string;
    dashboardRelevance?: number;
  },
>(findings: readonly T[]): T[] {
  return findings.filter(
    (finding) =>
      !isDataQualityDashboardFinding(finding) &&
      coachingObservationRelevance(finding) >=
        COACHING_OBSERVATIONS_RELEVANCE_THRESHOLD
  );
}

export const DATA_QUALITY_GAPS_CAP = 3;
export const ACTIVE_PROTOCOLS_CAP = 3;

export function capDashboardList<T>(
  items: readonly T[],
  cap: number
): { shown: T[]; overflow: T[] } {
  const n = Math.max(0, Math.trunc(cap));
  return { shown: items.slice(0, n), overflow: items.slice(n) };
}

export function capActionableDashboardList<T>(
  items: readonly T[],
  cap: number,
  isActionable: (item: T) => boolean
): { shown: T[]; overflow: T[] } {
  const actionable = items.filter(isActionable);
  const informational = items.filter((item) => !isActionable(item));
  const informationalSlots = Math.max(0, Math.trunc(cap) - actionable.length);
  return {
    shown: [...actionable, ...informational.slice(0, informationalSlots)],
    overflow: informational.slice(informationalSlots),
  };
}

export interface DashboardHabitProgress {
  count: number;
  per_week: number;
  met: boolean;
}

export type DashboardHabitDomain = "training" | "food" | "practice";

export function dashboardHabitDomain(scopeKind: string): DashboardHabitDomain {
  if (scopeKind === "food_group") return "food";
  if (scopeKind === "practice") return "practice";
  return "training";
}

export function summarizeDashboardHabits<T extends DashboardHabitProgress>(
  targets: readonly T[],
  limit = 4
): {
  open: T[];
  shown: T[];
  hidden: T[];
  completedCount: number;
  hiddenOpenCount: number;
} {
  const open = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.met)
    .sort(
      (a, b) =>
        a.target.count / Math.max(1, a.target.per_week) -
          b.target.count / Math.max(1, b.target.per_week) || a.index - b.index
    )
    .map(({ target }) => target);
  const shown = open.slice(0, Math.max(0, Math.trunc(limit)));
  const hidden = open.slice(shown.length);
  return {
    open,
    shown,
    hidden,
    completedCount: targets.length - open.length,
    hiddenOpenCount: hidden.length,
  };
}

export function dashboardGoalsHabitsLayout(
  hasGoals: boolean,
  hasHabits: boolean
): "split" | "full" {
  return hasGoals && hasHabits ? "split" : "full";
}
