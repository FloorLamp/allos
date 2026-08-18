import type { UpcomingItem } from "../upcoming";
import { bandForItem } from "../upcoming";
import { itemSuppressionPolicy } from "../upcoming-suppress";
import { actionCandidate, statementCandidate } from "./candidate";
import type {
  DashboardCandidate,
  DashboardObligation,
  DashboardSubject,
} from "../dashboard-relevance";

function attentionObligation(
  item: UpcomingItem,
  setup: boolean
): DashboardObligation {
  if (item.obligation) return item.obligation;
  if (setup || item.domain === "available") return "may";
  // A due date says when a fact matters, not that the source declared it a must.
  // Non-intake attention models do not carry the three-level obligation field.
  return "should";
}

export function attentionCandidates(
  subject: DashboardSubject,
  items: readonly UpcomingItem[],
  today: string,
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
      // Read access still owns the fact. Write capability controls the atom's
      // controls in presentation; filtering here erased safety information.
      applicable: true,
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
          obligation: attentionObligation(item, setup),
        })
      : statementCandidate(common);
  });
}
