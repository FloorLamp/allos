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

interface DashboardHabitProgress {
  count: number;
  per_week: number;
  met: boolean;
}

type DashboardHabitDomain = "training" | "food" | "practice";

export function dashboardHabitDomain(scopeKind: string): DashboardHabitDomain {
  if (scopeKind === "food_group") return "food";
  if (scopeKind === "practice") return "practice";
  return "training";
}

export function dashboardHabitHref(
  domain: DashboardHabitDomain
): "/nutrition" | "/wellness" | "/training" {
  switch (domain) {
    case "food":
      return "/nutrition";
    case "practice":
      return "/wellness";
    case "training":
      return "/training";
  }
}

export function orderDashboardHabits<T extends DashboardHabitProgress>(
  targets: readonly T[]
): T[] {
  const open = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.met)
    .sort(
      (a, b) =>
        a.target.count / Math.max(1, a.target.per_week) -
          b.target.count / Math.max(1, b.target.per_week) || a.index - b.index
    )
    .map(({ target }) => target);
  return [...open, ...targets.filter((target) => target.met)];
}
