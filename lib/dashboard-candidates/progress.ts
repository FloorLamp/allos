import { profileDataRelevance } from "./candidate";
import {
  action,
  changed,
  reading,
  state,
  statement,
  type DomainCandidateContext,
  type Engagement,
} from "./shared";

export const progressCandidates = {
  // THE FAMILY'S OWN groupKey (#4076 part 2). Statement families passed `null` here,
  // so the moment-block fold had nothing to fold on and N findings printed N blocks
  // headed with the same words. It stayed inert until the row grammar landed —
  // a family that renders cards never reaches the fold — so it lands with it.
  statement(
    ctx: DomainCandidateContext,
    family: string,
    id: string | number,
    factKey: string,
    groupKey: string | null = null
  ) {
    return statement(ctx, `${family}:${id}`, factKey, groupKey);
  },
  goal(ctx: DomainCandidateContext, id: number, promoted = false) {
    return reading(
      ctx,
      `goal.progress:${id}`,
      `outcome-goal.progress:${id}`,
      `goal:${id}`,
      "manual",
      "current",
      promoted
        ? {
            rankReasons: changed,
            readingPromotion: "outcome-goal-transition",
          }
        : {}
    );
  },
  // `behind` is the pace verdict, carried as the existing `owed` rank reason so
  // Standing's attention tier reads one vocabulary (#3548). It is inert in Now:
  // `nowScore` awards `owed` only to actions, so a behind READING never cards —
  // which is exactly the #3245 split (the card is gated by the moment, the
  // standing fact is told here).
  targetProgress(
    ctx: DomainCandidateContext,
    id: number,
    standingEligible = true,
    promoted = false,
    behind = false
  ) {
    return reading(
      ctx,
      `target.weekly-progress:${id}`,
      `frequency-target.progress:${id}`,
      `target:${id}`,
      "manual",
      "current",
      {
        standingEligible,
        rankReasons: {
          safety: false,
          owed: behind,
          windowOpen: false,
          changed: promoted,
        },
        ...(promoted
          ? { readingPromotion: "weekly-target-transition" as const }
          : {}),
      }
    );
  },
  trainingResult(
    ctx: DomainCandidateContext,
    key: string,
    day: string,
    ageDays: number
  ) {
    const group = `training.result:${day}`;
    return reading(
      ctx,
      `training.result:${key}:${day}`,
      `${group}:${key}`,
      group,
      "manual",
      "current",
      {
        timing: { kind: "local-days", ageDays, maxDays: 0 },
        rankReasons: changed,
        readingPromotion: "training-best",
      }
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
    // ONE MOMENT, NOT N ATOMS (#4232). The pillars stopped claiming a Standing seat,
    // so the family label that used to head them is gone with the band — the shared
    // `groupKey` is what folds them back into one block under one header in the tail,
    // exactly as #3365's grammar already does for same-origin atoms.
    return reading(
      ctx,
      `healthspan.pillar:${key}`,
      `healthspan.pillar:${key}`,
      "healthspan.pillars"
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
