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
      source === "wizard" ? "onboarding.setup" : "onboarding.checklist",
      "unknown",
      "current",
      { relevance: { kind: "setup" } }
    );
  },
  // ONE ROW PER REMAINING STEP (#4362 ruling 3). The checklist was one candidate
  // whose facts column held every remaining label joined by "·", so a first-run
  // reader got ONE door for four steps and none of the sentences saying why any of
  // them is worth doing. The owner ruled it earns its own moment block, and the
  // `data-candidate-id` census amendment that requires is sanctioned there.
  //
  // They share the checklist's groupKey with the progress row, so the block prints
  // one header over the set exactly as every other moment does.
  onboardingChecklistStep(ctx: DomainCandidateContext, suggestion: string) {
    return action(
      ctx,
      `onboarding.checklist:${suggestion}`,
      `onboarding.checklist-step:${suggestion}`,
      "onboarding.checklist",
      "may",
      { relevance: { kind: "setup" } }
    );
  },
};
