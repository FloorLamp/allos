import type {
  DashboardCandidate,
  DashboardObligation,
  DashboardRankReasons,
  DashboardRelevancePolicy,
  DashboardSubject,
  DashboardTiming,
} from "../dashboard-relevance";
import {
  actionCandidate,
  profileDataRelevance,
  readingCandidate,
  stateCandidate,
  statementCandidate,
} from "./candidate";

export type Engagement = "unknown" | "manual" | "external";
type Presence = "never" | "current" | "dormant";

export interface DomainCandidateContext {
  subject: DashboardSubject;
  sourceOrder: number;
  applicable?: boolean;
}

interface Policy {
  relevance?: DashboardRelevancePolicy;
  timing?: DashboardTiming;
  rankReasons?: DashboardRankReasons;
  standingEligible?: boolean;
}

const applicable = (ctx: DomainCandidateContext) => ctx.applicable ?? true;

export function action(
  ctx: DomainCandidateContext,
  candidateId: string,
  factKey: string,
  groupKey: string | null,
  obligation: DashboardObligation,
  policy: Policy = {}
): DashboardCandidate {
  return actionCandidate({
    candidateId,
    factKey,
    groupKey,
    subject: ctx.subject,
    applicable: applicable(ctx),
    relevance: { kind: "event" },
    obligation,
    sourceOrder: ctx.sourceOrder,
    ...policy,
  });
}

export function reading(
  ctx: DomainCandidateContext,
  candidateId: string,
  factKey: string,
  groupKey: string | null,
  engagement: Engagement = "unknown",
  presence: Presence = "current",
  policy: Policy = {}
): DashboardCandidate {
  return readingCandidate({
    candidateId,
    factKey,
    groupKey,
    subject: ctx.subject,
    applicable: applicable(ctx),
    relevance: profileDataRelevance(presence, engagement),
    sourceOrder: ctx.sourceOrder,
    ...policy,
  });
}

export function statement(
  ctx: DomainCandidateContext,
  candidateId: string,
  factKey: string,
  groupKey: string | null,
  policy: Policy = {}
): DashboardCandidate {
  return statementCandidate({
    candidateId,
    factKey,
    groupKey,
    subject: ctx.subject,
    applicable: applicable(ctx),
    relevance: { kind: "event" },
    sourceOrder: ctx.sourceOrder,
    ...policy,
  });
}

export function state(
  ctx: DomainCandidateContext,
  candidateId: string,
  factKey: string,
  groupKey: string | null,
  policy: Policy = {}
): DashboardCandidate {
  return stateCandidate({
    candidateId,
    factKey,
    groupKey,
    subject: ctx.subject,
    applicable: applicable(ctx),
    relevance: { kind: "state" },
    sourceOrder: ctx.sourceOrder,
    ...policy,
  });
}

export const changed: DashboardRankReasons = {
  safety: false,
  owed: false,
  windowOpen: false,
  changed: true,
};
