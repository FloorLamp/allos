import type { DashboardTiming } from "../dashboard-relevance";
import { profileDataRelevance } from "./candidate";
import {
  action,
  changed,
  reading,
  state,
  type DomainCandidateContext,
  type Engagement,
} from "./shared";

export const sleepCandidates = {
  waiting(ctx: DomainCandidateContext, day: string, timing: DashboardTiming) {
    return state(
      ctx,
      `sleep.waiting:${day}`,
      `sleep.waiting-state:${day}`,
      "sleep.last-night",
      { timing, rankReasons: changed }
    );
  },
  bootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "sleep.bootstrap",
      "sleep.first-source-offer",
      "sleep.last-night",
      "may",
      { relevance: profileDataRelevance("never") }
    );
  },
  dormant(ctx: DomainCandidateContext, lastRecord: string) {
    return state(
      ctx,
      "sleep.dormant",
      `sleep.dormancy:${lastRecord}`,
      "sleep.last-night",
      { relevance: profileDataRelevance("dormant") }
    );
  },
  refresh(ctx: DomainCandidateContext, day: string) {
    return action(
      ctx,
      "sleep.refresh",
      `sleep.refresh-offer:${day}`,
      "sleep.last-night",
      "may"
    );
  },
  reading(
    ctx: DomainCandidateContext,
    key: string,
    wakeDay: string,
    engagement: Engagement,
    timing: DashboardTiming
  ) {
    return reading(
      ctx,
      `sleep.${key}:${wakeDay}`,
      `sleep.${key}:${wakeDay}`,
      "sleep.last-night",
      engagement,
      "current",
      {
        timing,
        rankReasons: {
          safety: false,
          owed: false,
          windowOpen: true,
          changed: false,
        },
      }
    );
  },
  nap(
    ctx: DomainCandidateContext,
    date: string,
    startMinutes: number,
    engagement: Engagement,
    ageMinutes: number
  ) {
    return reading(
      ctx,
      `sleep.nap:${date}:${startMinutes}`,
      `sleep.nap:${date}:${startMinutes}`,
      `sleep.naps:${date}`,
      engagement,
      "current",
      {
        timing: { kind: "since-event", ageMinutes, maxMinutes: 180 },
        rankReasons: changed,
      }
    );
  },
  napTotal(ctx: DomainCandidateContext, day: string) {
    return reading(
      ctx,
      `sleep.nap-total:${day}`,
      `sleep.nap-total:${day}`,
      `sleep.naps:${day}`
    );
  },
};
