import type { DashboardTiming } from "../dashboard-relevance";
import { profileDataRelevance } from "./candidate";
import {
  action,
  reading,
  type DomainCandidateContext,
  type Engagement,
} from "./shared";

export const dailyCandidates = {
  moodCheckin(
    ctx: DomainCandidateContext,
    day: string,
    timing: DashboardTiming,
    owed: boolean
  ) {
    return action(
      ctx,
      "checkin.mood",
      `mood.checkin:${day}`,
      "checkin.daily",
      "should",
      {
        timing,
        rankReasons: {
          safety: false,
          owed,
          windowOpen: owed,
          changed: false,
        },
      }
    );
  },
  moodReading(ctx: DomainCandidateContext, key: string, day: string) {
    return reading(
      ctx,
      `mood.${key}:${day}`,
      `mood.${key}:${day}`,
      "checkin.daily",
      "manual"
    );
  },
  prn(ctx: DomainCandidateContext, id: number) {
    return action(
      ctx,
      `intake.prn:${id}`,
      `intake.prn-dose:${id}`,
      "checkin.daily",
      "may"
    );
  },
  symptomLog(ctx: DomainCandidateContext, day: string) {
    return action(
      ctx,
      "symptom.well-day-log",
      `symptom.log-offer:${day}`,
      "checkin.daily",
      "may"
    );
  },
  protein(
    ctx: DomainCandidateContext,
    day: string,
    engagement: Engagement,
    timing: DashboardTiming
  ) {
    return reading(
      ctx,
      `nutrition.protein:${day}`,
      `nutrition.protein-day:${day}`,
      "nutrition.today",
      engagement,
      "current",
      { timing }
    );
  },
  nutritionBootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "nutrition.bootstrap",
      "nutrition.first-log-offer",
      "nutrition.today",
      "may",
      { relevance: profileDataRelevance("never") }
    );
  },
  usualRoutine(
    ctx: DomainCandidateContext,
    window: string,
    day: string,
    timing: DashboardTiming
  ) {
    return action(
      ctx,
      `nutrition.usual-routine:${window}`,
      `nutrition.usual-routine-offer:${window}:${day}`,
      "nutrition.today",
      "may",
      { timing }
    );
  },
  steps(ctx: DomainCandidateContext, day: string) {
    return reading(
      ctx,
      `activity.steps:${day}`,
      `metric.steps:${day}`,
      null,
      "external"
    );
  },
  stepsBootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "activity.steps-bootstrap",
      "metric.steps-first-source",
      null,
      "may",
      { relevance: profileDataRelevance("never") }
    );
  },
  vital(
    ctx: DomainCandidateContext,
    kind: "blood-pressure" | "resting-heart-rate",
    date: string
  ) {
    return reading(
      ctx,
      `vitals.${kind}:${date}`,
      `vitals.${kind}:${date}`,
      "vitals.latest"
    );
  },
  vitalLog(ctx: DomainCandidateContext, day: string, hasReadings: boolean) {
    return action(
      ctx,
      "vitals.manual-log",
      `vitals.manual-log-offer:${day}`,
      "vitals.latest",
      "may",
      {
        relevance: hasReadings
          ? { kind: "event" }
          : profileDataRelevance("never"),
      }
    );
  },
  cyclePhase(ctx: DomainCandidateContext, day: string) {
    return reading(
      ctx,
      `cycle.phase:${day}`,
      `cycle.phase-day:${day}`,
      "cycle.current",
      "manual"
    );
  },
  cycleControl(ctx: DomainCandidateContext, day: string) {
    return action(
      ctx,
      "cycle.control",
      `cycle.control-offer:${day}`,
      "cycle.current",
      "may"
    );
  },
};
