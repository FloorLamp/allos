import type { UpcomingItem } from "../upcoming";
import { bandForItem } from "../upcoming";
import { itemSuppressionPolicy } from "../upcoming-suppress";
import { actionCandidate, statementCandidate } from "./candidate";
import type {
  DashboardCandidate,
  DashboardSubject,
} from "../dashboard-relevance";

export function attentionCandidates(
  subject: DashboardSubject,
  items: readonly UpcomingItem[],
  today: string,
  canWrite = true,
  sourceOrder = 0
): DashboardCandidate[] {
  return items.map((item, index) => {
    const setup = item.signalGroup === "setup";
    const dueNow =
      item.signalGroup == null &&
      (bandForItem(item, today) === "overdue" ||
        bandForItem(item, today) === "today");
    const actionable =
      item.actionLabel != null ||
      item.doseId != null ||
      item.followUpResolve != null ||
      item.followUpSettle != null;
    const common = {
      candidateId: `attention.fact:${item.key}`,
      factKey: `upcoming.${item.key}`,
      groupKey: item.signalGroup
        ? `attention.${item.signalGroup}`
        : "attention.due",
      subject,
      applicable: !actionable || canWrite,
      relevance: setup
        ? ({ kind: "setup" } as const)
        : ({ kind: "event" } as const),
      rankReasons: {
        safety: itemSuppressionPolicy(item) === "safety-ungated",
        owed: dueNow,
        windowOpen: dueNow,
        changed:
          item.signalGroup === "flagged" || item.signalGroup === "review",
      },
      sourceOrder: sourceOrder + index,
    };
    return actionable
      ? actionCandidate({
          ...common,
          obligation: setup || item.domain === "available" ? "may" : "must",
        })
      : statementCandidate(common);
  });
}
