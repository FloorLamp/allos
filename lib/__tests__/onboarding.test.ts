import { describe, expect, it } from "vitest";
import { customizableWidgetDefs } from "@/lib/dashboard-widgets";
import {
  completeOnboardingState,
  focusHasFirstValue,
  hasOnboardingFirstValue,
  initialOnboardingState,
  normalizeOnboardingFocuses,
  onboardingDashboardLayout,
  onboardingDeferred,
  onboardingNeedsSetup,
  onboardingNotificationSchedule,
  nextOnboardingStep,
  onboardingWithBasics,
  onboardingWithDataReviewed,
  onboardingWithFocuses,
  onboardingWithLayout,
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

    const layout = onboardingWithLayout(basics, "2026-07-15T10:02:00.000Z");
    const notifications = onboardingWithNotificationIntent(
      layout,
      "later",
      "2026-07-15T10:02:30.000Z"
    );
    expect(notifications).toMatchObject({
      layoutReviewed: true,
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
      onboardingWithLayout(complete, "2026-07-16T08:00:00.000Z"),
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
    expect(resolveOnboardingStep("7", basics, false)).toBe(4);
    expect(resolveOnboardingStep("2", basics, false)).toBe(2);

    const skippedData = onboardingWithDataReviewed(
      basics,
      "2026-07-15T10:01:30.000Z"
    );
    expect(nextOnboardingStep(skippedData, false)).toBe(5);

    const withValue = { ...basics, layoutReviewed: true };
    expect(nextOnboardingStep(withValue, true)).toBe(6);

    const reviewed = { ...withValue, notificationsReviewed: true };
    expect(nextOnboardingStep(reviewed, true)).toBe(7);
    expect(resolveOnboardingStep(undefined, reviewed, true)).toBe(7);
    expect(resolveOnboardingStep("not-a-step", reviewed, true)).toBe(7);
  });
});

describe("onboarding notification schedule", () => {
  const schedule = {
    supplementHours: { Morning: 8, Midday: 13, Evening: 20, Bedtime: 22 },
    workoutEnabled: true,
    digestHour: null,
    weeklyRecapDay: null,
    weeklyRecapHour: 9,
    milestonesEnabled: true,
    preventiveEnabled: true,
    wakingStartHour: 8,
    wakingEndHour: 21,
  };

  it("makes workout and upcoming-care differences explicit in the saved schedule", () => {
    const safety = onboardingNotificationSchedule("safety-only", schedule);
    expect(safety).toMatchObject({
      workoutEnabled: false,
      digestHour: null,
      preventiveEnabled: false,
    });

    const guidance = onboardingNotificationSchedule(
      "daily-essentials",
      schedule
    );
    expect(guidance).toMatchObject({
      workoutEnabled: true,
      digestHour: 8,
      preventiveEnabled: false,
    });

    const upcoming = onboardingNotificationSchedule(
      "essentials-upcoming",
      schedule
    );
    expect(upcoming).toMatchObject({
      workoutEnabled: true,
      digestHour: 8,
      preventiveEnabled: true,
    });

    const none = onboardingNotificationSchedule("none", schedule);
    expect(none).toMatchObject({
      supplementHours: {
        Morning: null,
        Midday: null,
        Evening: null,
        Bedtime: null,
      },
      workoutEnabled: false,
      digestHour: null,
      milestonesEnabled: false,
      preventiveEnabled: false,
    });
  });

  it("restores intake reminder defaults when changing away from no notifications", () => {
    const disabled = onboardingNotificationSchedule("none", schedule);

    expect(
      onboardingNotificationSchedule("safety-only", disabled, "none")
        .supplementHours
    ).toEqual({ Morning: 8, Midday: 13, Evening: 20, Bedtime: 22 });

    const manuallyAdjusted = {
      ...disabled,
      supplementHours: { ...disabled.supplementHours, Evening: 19 },
    };
    expect(
      onboardingNotificationSchedule("safety-only", manuallyAdjusted, "none")
        .supplementHours
    ).toEqual({ Morning: null, Midday: null, Evening: 19, Bedtime: null });
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

describe("onboarding dashboard layout", () => {
  it("fitness prioritizes training surfaces without permanently removing others", () => {
    const layout = onboardingDashboardLayout(["fitness"]);
    expect(layout.order.slice(0, 4)).toEqual([
      "coaching",
      "weight-trend",
      "goals-habits",
      "weekly-recap",
    ]);
    expect(layout.hidden).toContain("recent-labs");
    expect(layout.hidden).not.toContain("coaching");
    expect(layout.hidden).not.toContain("symptom-log");
    expect(layout.hidden).toContain("quick-log-prn");
    expect(layout.order).toContain("recent-labs");
  });

  it("combines two outcomes and leaves explore broad", () => {
    const combined = onboardingDashboardLayout([
      "medical-records",
      "metrics-labs",
    ]);
    expect(combined.hidden).not.toContain("recent-labs");
    expect(combined.hidden).not.toContain("weight-trend");
    expect(combined.hidden).toContain("coaching");

    const explore = onboardingDashboardLayout(["explore"]);
    expect(explore.hidden).toEqual(["weekly-recap"]);
    expect(explore.order).toEqual(
      expect.arrayContaining(["quick-log-prn", "symptom-log"])
    );
  });

  it("keeps the onboarding catalog synchronized with dashboard widgets", () => {
    const layout = onboardingDashboardLayout(["metrics-labs"]);
    const customizableIds = customizableWidgetDefs(false).map(
      (widget) => widget.id
    );

    expect(layout.order).toEqual(expect.arrayContaining(customizableIds));
    expect(layout.order).toHaveLength(customizableIds.length);
  });
});
