import { profileDataRelevance } from "./candidate";
import {
  action,
  reading,
  state,
  statement,
  type DomainCandidateContext,
  type Engagement,
} from "./shared";

export const progressCandidates = {
  statement(
    ctx: DomainCandidateContext,
    family: string,
    id: string | number,
    factKey: string
  ) {
    return statement(ctx, `${family}:${id}`, factKey, null);
  },
  goal(ctx: DomainCandidateContext, id: number) {
    return reading(
      ctx,
      `goal.progress:${id}`,
      `outcome-goal.progress:${id}`,
      `goal:${id}`,
      "manual"
    );
  },
  targetProgress(
    ctx: DomainCandidateContext,
    id: number,
    standingEligible = true
  ) {
    return reading(
      ctx,
      `target.weekly-progress:${id}`,
      `frequency-target.progress:${id}`,
      `target:${id}`,
      "manual",
      "current",
      { standingEligible }
    );
  },
  targetLog(
    ctx: DomainCandidateContext,
    id: number,
    day: string,
    owed: boolean,
    windowOpen: boolean
  ) {
    return action(
      ctx,
      `target.log:${id}`,
      `frequency-target.log-offer:${id}:${day}`,
      `target:${id}`,
      "should",
      {
        rankReasons: {
          safety: false,
          owed,
          windowOpen,
          changed: false,
        },
      }
    );
  },
  protocol(
    ctx: DomainCandidateContext,
    kind: "state" | "adherence" | "outcome" | "practice",
    id: number,
    day?: string,
    owed = false
  ) {
    const group = `protocol:${id}`;
    if (kind === "state")
      return state(ctx, `protocol.state:${id}`, `protocol.active:${id}`, group);
    if (kind === "adherence")
      return reading(
        ctx,
        `protocol.adherence:${id}`,
        `protocol.adherence-progress:${id}`,
        group,
        "manual"
      );
    if (kind === "outcome")
      return reading(
        ctx,
        `protocol.outcome:${id}`,
        `protocol.primary-outcome:${id}`,
        group
      );
    return action(
      ctx,
      `protocol.practice:${id}`,
      `protocol.practice-due:${id}:${day}`,
      group,
      "should",
      {
        rankReasons: {
          safety: false,
          owed,
          windowOpen: owed,
          changed: false,
        },
      }
    );
  },
  weightBootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "weight.bootstrap",
      "weight.first-reading-offer",
      "weight.summary",
      "may",
      { relevance: profileDataRelevance("never") }
    );
  },
  weightDormant(ctx: DomainCandidateContext, lastRecord: string) {
    return state(
      ctx,
      "weight.dormant",
      `weight.dormancy:${lastRecord}`,
      "weight.summary",
      { relevance: profileDataRelevance("dormant") }
    );
  },
  weightLatest(
    ctx: DomainCandidateContext,
    date: string,
    engagement: Engagement
  ) {
    return reading(
      ctx,
      `weight.latest:${date}`,
      `weight.reading:${date}`,
      "weight.summary",
      engagement
    );
  },
  weightTrend(
    ctx: DomainCandidateContext,
    since: string,
    day: string,
    engagement: Engagement
  ) {
    return reading(
      ctx,
      "weight.trend",
      `weight.trend:${since}:${day}`,
      "weight.summary",
      engagement
    );
  },
  healthspan(ctx: DomainCandidateContext, key: string) {
    return reading(
      ctx,
      `healthspan.pillar:${key}`,
      `healthspan.pillar:${key}`,
      null
    );
  },
  recap(ctx: DomainCandidateContext, key: string, start: string, end: string) {
    return statement(
      ctx,
      `recap.${key}:${start}`,
      `recap.${key}:${start}:${end}`,
      `recap:${start}:${end}`
    );
  },
};
