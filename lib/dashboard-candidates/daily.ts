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
  // TODAY'S PHYSIOLOGY THROUGH THE DAY (#4767 item 2). A reading, not a state: it
  // reports what the watch has recorded, and it is `external` because nothing a
  // person types can produce it. Day-keyed, so it expires at midnight by
  // construction — the property that made this the one chart worth putting here.
  intraday(ctx: DomainCandidateContext, day: string) {
    return reading(
      ctx,
      `activity.intraday:${day}`,
      `metric.intraday:${day}`,
      null,
      "external"
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
  // The same row's slot when the quantity has gone quiet for a year (#3226). Its
  // candidateId keeps the `vitals.<kind>:` prefix so the Standing family claims it in the
  // seat the reading vacated — same section, same order, no family-level collapse.
  //
  // AN ACTION, NOT A STATE (#4841 item 3). "No blood pressure recorded since Mar 2022"
  // is a prompt to take a reading: it cannot resolve on its own, and the only thing
  // that ends it is the measurement. Declaring the kind is what routes it to Act and
  // earns it the write control; the relevance stays profile-data/dormant, which is
  // what still hands it to the Standing family's tail and keeps #2652's one-honest-
  // line rule and the dormant presence exactly where they were.
  vitalDormant(
    ctx: DomainCandidateContext,
    kind: "blood-pressure" | "resting-heart-rate",
    lastRecord: string
  ) {
    return action(
      ctx,
      `vitals.${kind}:dormant`,
      `vitals.${kind}:dormancy:${lastRecord}`,
      "vitals.latest",
      "may",
      { relevance: profileDataRelevance("dormant") }
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
};
