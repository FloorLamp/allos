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
