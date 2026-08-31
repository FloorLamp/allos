import type { UpcomingItem } from "../upcoming";
import { bandForItem, upcomingDueText } from "../upcoming";
import { itemSuppressionPolicy } from "../upcoming-suppress";
import { doseBucketFromSortHint } from "../dose-order";
import { TIME_BUCKET_OPENS_AT } from "../intake-schedule";
import { formatClockMinutes, type DisplayFormatPrefs } from "../format-date";
import { preventiveReviewFactKey } from "../preventive-review";
import { actionCandidate, statementCandidate } from "./candidate";
import type {
  DashboardCandidate,
  DashboardObligation,
  DashboardSubject,
} from "../dashboard-relevance";
import {
  dashboardAttentionCandidateId,
  dashboardAttentionFactKey,
} from "../dashboard-attention-identity";
import { localTimeWindow } from "../dashboard-relevance";

function doseOpensAt(item: UpcomingItem): number | null {
  if (item.domain !== "dose") return null;
  const bucket = doseBucketFromSortHint(item.sortHint);
  return bucket == null ? null : TIME_BUCKET_OPENS_AT[bucket];
}

export function attentionAheadDetail(
  item: UpcomingItem,
  today: string,
  prefs: DisplayFormatPrefs
): string {
  const detail = upcomingDueText(item, today, prefs);
  const opensAt = doseOpensAt(item);
  return opensAt == null
    ? detail
    : `${detail} · from ${formatClockMinutes(prefs.timeFormat, opensAt)}`;
}

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
    const opensAt = doseOpensAt(item);
    const setup = item.signalGroup === "setup";
    const dueNow =
      item.signalGroup == null &&
      (bandForItem(item, today) === "overdue" ||
        bandForItem(item, today) === "today");
    // Upcoming exposes one due-now fact, so this producer cannot distinguish
    // owed from window-open. The separate Now tiers remain reachable through
    // target-log candidates, which carry the two booleans independently (#4255).
    // Carry the owning Upcoming surface's declared affordances. `actionLabel`
    // covers only navigation-first status rows; the typed one-tap actions have
    // their own source fields and are still action candidates even when the
    // current viewer cannot perform the write.
    const actionable =
      item.actionLabel != null ||
      item.altAction != null ||
      item.doseId != null ||
      item.practiceTargetId != null ||
      item.preventiveRuleKey != null ||
      item.bookHref != null ||
      item.carePlanItemId != null ||
      item.conditionSuggestion != null ||
      item.followUpResolve != null ||
      item.followUpSettle != null;
    const common = {
      candidateId: dashboardAttentionCandidateId(item.key),
      factKey: dashboardAttentionFactKey(item.key),
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
      timing:
        opensAt == null ? undefined : localTimeWindow(opensAt, 24 * 60 - 1),
      // The candidate's rank tiebreak IS this list's index, so the order the
      // model arrives in decides which owed `must` doses survive
      // NOW_CANDIDATE_CAP when they all score alike. buildAttentionModel states
      // and guarantees that order — date → priority → domain → dose-day slot
      // (#297) → title → key — so this index means the canonical dose-day order,
      // never raw generator emission (#3554).
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

// A preventive REVIEW CANDIDATE (#3025): one dashboard fact per open
// record/rule candidate riding on a due preventive item, keyed
// `preventive-review:<recordId>:<ruleKey>`. Structurally BARRED from the Now
// lane: every rank reason is false and the obligation is "may", so nowScore is
// null in rankDashboardCandidates and the fact can only land in the exhaustive
// Show everything remainder — a suggestion the person goes looking for, never an
// attention claim, never a send.
export function preventiveReviewCandidate(
  subject: DashboardSubject,
  offer: { recordId: number; ruleKey: string },
  sourceOrder: number
): DashboardCandidate {
  const key = preventiveReviewFactKey(offer);
  return actionCandidate({
    candidateId: key,
    factKey: key,
    groupKey: "attention.preventive-review",
    subject,
    applicable: true,
    relevance: { kind: "event" },
    obligation: "may",
    sourceOrder,
  });
}
