import type {
  DashboardCandidate,
  DashboardObligation,
  DashboardRankReasons,
  DashboardRelevancePolicy,
  DashboardSubject,
  DashboardTiming,
} from "../dashboard-relevance";
import type { AppRoute } from "../hrefs";
import {
  actionCandidate,
  profileDataRelevance,
  readingCandidate,
  stateCandidate,
  statementCandidate,
} from "./candidate";

type Engagement = "unknown" | "manual" | "external";
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
  defaultPlacement?: "standing" | "everything";
}

const applicable = (ctx: DomainCandidateContext) => ctx.applicable ?? true;

function action(
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

function reading(
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

function statement(
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

function state(
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

const changed: DashboardRankReasons = {
  safety: false,
  owed: false,
  windowOpen: false,
  changed: true,
};

export const careCandidates = {
  illnessState(ctx: DomainCandidateContext, key: string) {
    return state(
      ctx,
      `illness.state:${key}`,
      `illness.episode:${key}`,
      `illness.episode:${key}`,
      {
        rankReasons: changed,
      }
    );
  },
  illnessReading(
    ctx: DomainCandidateContext,
    kind: "temperature" | "medication",
    key: string
  ) {
    return reading(
      ctx,
      `illness.${kind}:${key}`,
      `illness.${kind}:${key}`,
      `illness.episode:${key}`,
      "manual"
    );
  },
  illnessOpen(ctx: DomainCandidateContext, key: string) {
    return action(
      ctx,
      `illness.open:${key}`,
      `illness.care-action:${key}`,
      `illness.episode:${key}`,
      "may"
    );
  },
  illnessReopen(ctx: DomainCandidateContext, key: string) {
    return action(
      ctx,
      `illness.reopen:${key}`,
      `illness.closed-episode:${key}`,
      `illness.episode:${key}`,
      "may"
    );
  },
  householdHistory(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "household.episode-history",
      "household.recent-episode-history",
      "household.episodes",
      "may"
    );
  },
  appointment(ctx: DomainCandidateContext, href: AppRoute) {
    return statement(ctx, "appointment.next", `appointment.next:${href}`, null);
  },
  lab(ctx: DomainCandidateContext, name: string) {
    return reading(
      ctx,
      `labs.latest:${name}`,
      `clinical-result.latest:${name}`,
      null
    );
  },
  labBootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "labs.bootstrap",
      "clinical-result.first-import",
      null,
      "may",
      {
        relevance: profileDataRelevance("never"),
      }
    );
  },
};

export const setupCandidates = {
  streamOffer(ctx: DomainCandidateContext, key: string) {
    return action(
      ctx,
      `stream.offer:${key}`,
      `stream.lifecycle:${key}`,
      null,
      "may"
    );
  },
  sessionRecap(
    ctx: DomainCandidateContext,
    activityId: number,
    key: string,
    ageMinutes: number
  ) {
    const group = `session.finished:${activityId}`;
    return statement(
      ctx,
      `session.recap:${activityId}:${key}`,
      `${group}:${key}`,
      group,
      {
        timing: { kind: "since-event", ageMinutes, maxMinutes: 60 },
        rankReasons: changed,
      }
    );
  },
  onboardingStep(ctx: DomainCandidateContext, step: number) {
    return action(
      ctx,
      `onboarding.step:${step}`,
      `onboarding.setup-step:${step}`,
      "onboarding.setup",
      "should",
      {
        relevance: { kind: "setup" },
      }
    );
  },
  onboardingProgress(
    ctx: DomainCandidateContext,
    source: "wizard" | "checklist"
  ) {
    return reading(
      ctx,
      "onboarding.progress",
      source === "wizard"
        ? "onboarding.setup-progress"
        : "onboarding.checklist-progress",
      "onboarding.setup",
      "unknown",
      "current",
      { relevance: { kind: "setup" }, defaultPlacement: "everything" }
    );
  },
  householdAttention(ctx: DomainCandidateContext, count: number) {
    const profileId =
      ctx.subject.scope === "profile" ? ctx.subject.profileId : "unknown";
    return statement(
      ctx,
      `household.attention:${profileId}`,
      `household.attention-count:${profileId}:${count}`,
      "household.profiles",
      { relevance: { kind: "state" } }
    );
  },
};

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
      {
        relevance: profileDataRelevance("never"),
      }
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
      {
        relevance: profileDataRelevance("never"),
      }
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
  targetProgress(ctx: DomainCandidateContext, id: number) {
    return reading(
      ctx,
      `target.weekly-progress:${id}`,
      `frequency-target.progress:${id}`,
      `target:${id}`,
      "manual"
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
      {
        relevance: profileDataRelevance("never"),
      }
    );
  },
  weightDormant(ctx: DomainCandidateContext, lastRecord: string) {
    return state(
      ctx,
      "weight.dormant",
      `weight.dormancy:${lastRecord}`,
      "weight.summary",
      {
        relevance: profileDataRelevance("dormant"),
      }
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

export const sleepCandidates = {
  waiting(ctx: DomainCandidateContext, day: string, timing: DashboardTiming) {
    return state(
      ctx,
      `sleep.waiting:${day}`,
      `sleep.waiting-state:${day}`,
      "sleep.last-night",
      {
        timing,
        rankReasons: changed,
      }
    );
  },
  bootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "sleep.bootstrap",
      "sleep.first-source-offer",
      "sleep.last-night",
      "may",
      {
        relevance: profileDataRelevance("never"),
      }
    );
  },
  dormant(ctx: DomainCandidateContext, lastRecord: string) {
    return state(
      ctx,
      "sleep.dormant",
      `sleep.dormancy:${lastRecord}`,
      "sleep.last-night",
      {
        relevance: profileDataRelevance("dormant"),
      }
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
