import {
  action,
  changed,
  reading,
  state,
  statement,
  type DomainCandidateContext,
} from "./shared";

export const setupCandidates = {
  vitalsBootstrap(ctx: DomainCandidateContext) {
    return action(ctx, "vitals.bootstrap", "vitals.bootstrap", null, "may", {
      relevance: { kind: "setup" },
    });
  },
  liveWorkout(ctx: DomainCandidateContext, activityId: number | null) {
    const key = activityId ?? "active";
    return state(ctx, `workout.live:${key}`, `workout.live:${key}`, null, {
      rankReasons: changed,
    });
  },
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
      { relevance: { kind: "setup" } }
    );
  },
};
