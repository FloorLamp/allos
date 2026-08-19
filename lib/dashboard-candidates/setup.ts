import {
  action,
  changed,
  reading,
  statement,
  type DomainCandidateContext,
} from "./shared";

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
      { relevance: { kind: "setup" } }
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
