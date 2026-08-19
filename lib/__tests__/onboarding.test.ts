import { describe, expect, it } from "vitest";
import { DIGEST_DEFAULT_MINUTE } from "@/lib/notifications/digest-schedule";
import {
  completeOnboardingState,
  focusHasFirstValue,
  hasOnboardingFirstValue,
  initialOnboardingState,
  normalizeOnboardingFocuses,
  onboardingDeferred,
  onboardingNeedsSetup,
  onboardingNotificationSchedule,
  nextOnboardingStep,
  onboardingWithBasics,
  onboardingWithDataReviewed,
  onboardingWithFocuses,
  onboardingWithNotificationIntent,
  onboardingWithProfilePath,
  parseOnboardingState,
  remainingOnboardingChecklistSuggestions,
  resolveOnboardingStep,
  serializeOnboardingState,
  type OnboardingDataPresence,
} from "@/lib/onboarding";

const emptyPresence: OnboardingDataPresence = {
  medicalRecords: false,
  medications: false,
  fitness: false,
  metricsLabs: false,
  preventiveCare: false,
  caregiving: false,
};

describe("onboarding state", () => {
  it("is versioned, defensive, and never invents state for legacy profiles", () => {
    expect(parseOnboardingState(undefined)).toBeNull();
    expect(parseOnboardingState("not json")).toBeNull();
    expect(parseOnboardingState('{"version":2}')).toBeNull();

    const initial = initialOnboardingState();
    expect(parseOnboardingState(serializeOnboardingState(initial))).toEqual(
      initial
    );
    expect(onboardingNeedsSetup(initial)).toBe(true);
    expect(onboardingNeedsSetup(null)).toBe(false);
    expect(initial.profilePath).toBeNull();
    expect(initial.dataReviewed).toBe(false);
    expect(initial.notificationIntent).toBeNull();

    const deferred = onboardingDeferred(initial, "2026-07-15T09:58:00.000Z");
    expect(deferred).toMatchObject({
      status: "in_progress",
      profilePath: null,
      startedAt: "2026-07-15T09:58:00.000Z",
    });
  });

  it("ignores the retired dashboard-choice marker in historical state", () => {
    const historical = JSON.stringify({
      ...initialOnboardingState(),
      layoutReviewed: true,
    });
    const parsed = parseOnboardingState(historical);

    expect(parsed).toEqual(initialOnboardingState());
    expect(serializeOnboardingState(parsed!)).not.toContain("layoutReviewed");
  });

  it("normalizes one or two outcomes and makes explore exclusive", () => {
    expect(
      normalizeOnboardingFocuses([
        "fitness",
        "fitness",
        "metrics-labs",
        "medications",
      ])
    ).toEqual(["fitness", "metrics-labs"]);
    expect(
      normalizeOnboardingFocuses(["fitness", "explore", "medications"])
    ).toEqual(["explore"]);
    expect(normalizeOnboardingFocuses(["forged", null])).toEqual([]);
  });

  it("advances without turning unknown profile facts into answers", () => {
    const person = onboardingWithProfilePath(
      initialOnboardingState(),
      "self",
      "2026-07-15T09:59:00.000Z"
    );
    const started = onboardingWithFocuses(
      person,
      ["medical-records"],
      "2026-07-15T10:00:00.000Z"
    );
    expect(started).toMatchObject({
      status: "in_progress",
      profilePath: "self",
      focuses: ["medical-records"],
      basicsComplete: false,
      startedAt: "2026-07-15T09:59:00.000Z",
    });

    const basics = onboardingWithBasics(started, "2026-07-15T10:01:00.000Z");
    expect(basics.basicsComplete).toBe(true);
    expect(basics.startedAt).toBe(started.startedAt);

    const notifications = onboardingWithNotificationIntent(
      basics,
      "later",
      "2026-07-15T10:02:30.000Z"
    );
    expect(notifications).toMatchObject({
      notificationIntent: "later",
      notificationsReviewed: true,
    });

    const complete = completeOnboardingState(
      notifications,
      "2026-07-15T10:03:00.000Z"
    );
    expect(complete.status).toBe("complete");
    expect(complete.completedAt).toBe("2026-07-15T10:03:00.000Z");
    expect(onboardingNeedsSetup(complete)).toBe(false);

    // #887: revisiting ANY step after completion applies the field edit but never
    // downgrades status back to in_progress or clears completedAt (monotonic).
    const revisitFocuses = onboardingWithFocuses(
      complete,
      ["fitness"],
      "2026-07-16T08:00:00.000Z"
    );
    expect(revisitFocuses).toMatchObject({
      status: "complete",
      completedAt: "2026-07-15T10:03:00.000Z",
      focuses: ["fitness"],
    });
    expect(onboardingNeedsSetup(revisitFocuses)).toBe(false);

    // Same monotonic guard across the other reopening transitions.
    for (const revisited of [
      onboardingWithBasics(complete, "2026-07-16T08:00:00.000Z"),
      onboardingWithDataReviewed(complete, "2026-07-16T08:00:00.000Z"),
      onboardingWithNotificationIntent(
        complete,
        "safety-only",
        "2026-07-16T08:00:00.000Z"
      ),
    ]) {
      expect(revisited.status).toBe("complete");
      expect(revisited.completedAt).toBe("2026-07-15T10:03:00.000Z");
    }
  });
});

describe("onboarding checklist", () => {
  it("omits completed focus, emergency, and notification suggestions", () => {
    expect(
      remainingOnboardingChecklistSuggestions(["metrics-labs", "fitness"], {
        ...emptyPresence,
        metricsLabs: true,
        emergency: false,
        notifications: false,
        connectedDataSource: false,
      })
    ).toEqual(["fitness", "explore", "notifications"]);

    expect(
      remainingOnboardingChecklistSuggestions(["explore"], {
        ...emptyPresence,
        emergency: true,
        notifications: true,
        connectedDataSource: false,
      })
    ).toEqual([]);

    expect(
      remainingOnboardingChecklistSuggestions(["fitness"], {
        ...emptyPresence,
        fitness: true,
        emergency: true,
        notifications: true,
        connectedDataSource: false,
      })
    ).toEqual(["fitness"]);
    expect(
      remainingOnboardingChecklistSuggestions(["fitness"], {
        ...emptyPresence,
        emergency: true,
        notifications: true,
        connectedDataSource: true,
      })
    ).toEqual([]);
  });
});

describe("onboarding wizard steps", () => {
  it("unlocks one page at a time and allows revisiting earlier pages", () => {
    const initial = initialOnboardingState();
    expect(nextOnboardingStep(initial, false)).toBe(1);

    const path = { ...initial, profilePath: "self" as const };
    expect(nextOnboardingStep(path, false)).toBe(2);

    const focused = { ...path, focuses: ["fitness" as const] };
    expect(nextOnboardingStep(focused, false)).toBe(3);

    const basics = { ...focused, basicsComplete: true };
    expect(nextOnboardingStep(basics, false)).toBe(4);
    expect(resolveOnboardingStep("6", basics, false)).toBe(4);
    expect(resolveOnboardingStep("2", basics, false)).toBe(2);

    const skippedData = onboardingWithDataReviewed(
      basics,
      "2026-07-15T10:01:30.000Z"
    );
    expect(nextOnboardingStep(skippedData, false)).toBe(5);

    expect(nextOnboardingStep(basics, true)).toBe(5);

    const reviewed = { ...basics, notificationsReviewed: true };
    expect(nextOnboardingStep(reviewed, true)).toBe(6);
    expect(resolveOnboardingStep(undefined, reviewed, true)).toBe(6);
    expect(resolveOnboardingStep("not-a-step", reviewed, true)).toBe(6);
  });
});

describe("onboarding notification schedule", () => {
  const schedule = {
    supplementMinutes: {
      Morning: 8 * 60,
      Midday: 13 * 60,
      Evening: 20 * 60,
      Bedtime: 22 * 60,
    },
    morningAuto: false,
    workoutEnabled: true,
    digestMinute: null,
    digestMode: "static" as const,
    weeklyRecapDay: null,
    weeklyRecapMinute: 9 * 60,
    recapScale: "week" as const,
    milestonesEnabled: true,
    preventiveEnabled: true,
    wakingStartHour: 8,
    wakingEndHour: 21,
  };

  it("makes workout and upcoming-care differences explicit in the saved schedule", () => {
    const safety = onboardingNotificationSchedule("safety-only", schedule);
    expect(safety).toMatchObject({
      workoutEnabled: false,
      digestMinute: null,
      preventiveEnabled: false,
    });

    const guidance = onboardingNotificationSchedule(
      "daily-essentials",
      schedule
    );
    expect(guidance).toMatchObject({
      workoutEnabled: true,
      digestMinute: DIGEST_DEFAULT_MINUTE,
      preventiveEnabled: false,
    });

    const upcoming = onboardingNotificationSchedule(
      "essentials-upcoming",
      schedule
    );
    expect(upcoming).toMatchObject({
      workoutEnabled: true,
      digestMinute: DIGEST_DEFAULT_MINUTE,
      preventiveEnabled: true,
    });

    const none = onboardingNotificationSchedule("none", schedule);
    expect(none).toMatchObject({
      supplementMinutes: {
        Morning: null,
        Midday: null,
        Evening: null,
        Bedtime: null,
      },
      workoutEnabled: false,
      digestMinute: null,
      milestonesEnabled: false,
      preventiveEnabled: false,
    });
  });

  it("restores intake reminder defaults when changing away from no notifications", () => {
    const disabled = onboardingNotificationSchedule("none", schedule);

    expect(
      onboardingNotificationSchedule("safety-only", disabled, "none")
        .supplementMinutes
    ).toEqual({
      Morning: 8 * 60,
      Midday: 13 * 60,
      Evening: 20 * 60,
      Bedtime: 22 * 60,
    });

    const manuallyAdjusted = {
      ...disabled,
      supplementMinutes: { ...disabled.supplementMinutes, Evening: 19 * 60 },
    };
    expect(
      onboardingNotificationSchedule("safety-only", manuallyAdjusted, "none")
        .supplementMinutes
    ).toEqual({ Morning: null, Midday: null, Evening: 19 * 60, Bedtime: null });
  });
});

describe("onboarding first value", () => {
  it("matches each outcome to its own real data domain", () => {
    const presence: OnboardingDataPresence = {
      ...emptyPresence,
      fitness: true,
    };
    expect(focusHasFirstValue("fitness", presence)).toBe(true);
    expect(focusHasFirstValue("medical-records", presence)).toBe(false);
    expect(
      hasOnboardingFirstValue(["medical-records", "fitness"], presence)
    ).toBe(true);
    expect(hasOnboardingFirstValue(["medications"], presence)).toBe(false);
    expect(focusHasFirstValue("explore", presence)).toBe(true);
  });
});
