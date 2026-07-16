import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  completeOnboarding,
  continueOnboardingData,
  deferOnboarding,
  dismissProfileOrientation,
  saveOnboardingBasics,
  saveOnboardingDashboard,
  saveOnboardingFocuses,
  saveOnboardingNotifications,
  saveOnboardingProfilePath,
  startOnboardingRoutine,
} from "@/app/(app)/onboarding/actions";
import { createProfile as createProfileAction } from "@/app/(app)/settings/family/actions";
import { setMinTrainingAge } from "@/lib/age-gate";
import { db } from "@/lib/db";
import {
  getDashboardLayout,
  getOnboardingState,
  getNotifySchedule,
  getStoredAge,
  getUnitPrefs,
  getUserBirthdate,
  getUserSex,
  isProfileOrientationDismissed,
  setOnboardingState,
  setUserBirthdate,
} from "@/lib/settings";
import { initialOnboardingState } from "@/lib/onboarding";
import { getActiveRoutine, getRoutines } from "@/lib/routines";
import {
  createLogin,
  createProfile as createTestProfile,
  seedActor,
  actAs,
  fd,
} from "./harness";

const revalidate = vi.mocked(revalidatePath);

async function redirected(action: Promise<unknown>) {
  await expect(action).rejects.toThrow(/NEXT_REDIRECT/);
}

beforeEach(() => revalidate.mockClear());
afterEach(() => setMinTrainingAge(null));

describe("onboarding actions", () => {
  it("defers setup without inventing who the profile represents", async () => {
    const login = createLogin({ username: "onboarding-later" });
    const profile = createTestProfile("Later Person", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, initialOnboardingState());

    await redirected(deferOnboarding());
    expect(getOnboardingState(profile.id)).toMatchObject({
      status: "in_progress",
      profilePath: null,
    });
  });

  it("dismisses existing-profile orientation at the login tier", async () => {
    const login = createLogin({ username: "orientation-dismiss" });
    const profile = createTestProfile("Existing Person", login.id);
    actAs(login, profile);

    expect(isProfileOrientationDismissed(login.id, profile.id)).toBe(false);
    await dismissProfileOrientation();
    expect(isProfileOrientationDismissed(login.id, profile.id)).toBe(true);
  });

  it("opts an admin-created profile into versioned onboarding", async () => {
    seedActor({ role: "admin" });
    const result = await createProfileAction(
      fd({ name: "New Family Profile" })
    );
    expect(result.ok).toBe(true);
    const created = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get("New Family Profile") as { id: number };
    expect(getOnboardingState(created.id)).toEqual(initialOnboardingState());
  });

  it("stores selected outcomes and seeds a profile-scoped dashboard layout", async () => {
    const login = createLogin({ username: "onboarding-focus" });
    const profile = createTestProfile("New Person", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, initialOnboardingState());

    await redirected(saveOnboardingProfilePath(fd({ profile_path: "self" })));

    const focuses = new FormData();
    focuses.append("focus", "fitness");
    focuses.append("focus", "metrics-labs");
    focuses.append("focus", "forged");
    await redirected(saveOnboardingFocuses(focuses));

    expect(getOnboardingState(profile.id)).toMatchObject({
      status: "in_progress",
      focuses: ["fitness", "metrics-labs"],
    });
    expect(getDashboardLayout(profile.id)?.hidden).not.toContain(
      "weight-trend"
    );
    expect(getDashboardLayout(profile.id)?.hidden).toContain(
      "next-appointment"
    );
  });

  it("writes profile facts at profile tier and units at login tier", async () => {
    const login = createLogin({ username: "onboarding-basics" });
    const profile = createTestProfile("Temporary", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, {
      ...initialOnboardingState(),
      status: "in_progress",
      profilePath: "self",
      focuses: ["metrics-labs"],
    });

    await redirected(
      saveOnboardingBasics(
        fd({
          display_name: "Ada Example",
          sex: "female",
          birthdate: "",
          age: "38",
          timezone: "America/New_York",
          weight_unit: "lb",
          distance_unit: "mi",
        })
      )
    );

    expect(
      db.prepare("SELECT name FROM profiles WHERE id = ?").get(profile.id)
    ).toEqual({ name: "Ada Example" });
    expect(getUserSex(profile.id)).toBe("female");
    expect(getUserBirthdate(profile.id)).toBeNull();
    expect(getStoredAge(profile.id)).toBe(38);
    expect(getUnitPrefs(login.id)).toEqual({
      weightUnit: "lb",
      distanceUnit: "mi",
    });
    expect(getOnboardingState(profile.id)?.basicsComplete).toBe(true);

    await redirected(
      saveOnboardingBasics(
        fd({
          display_name: "Ada Example",
          sex: "female",
          birthdate: "2000-01-01",
          age: "38",
          timezone: "America/New_York",
          weight_unit: "lb",
          distance_unit: "mi",
        })
      )
    );
    expect(getUserBirthdate(profile.id)).toBe("2000-01-01");
    expect(getStoredAge(profile.id)).toBeNull();
  });

  it("adopts and activates a starter routine in one tap on a fresh profile", async () => {
    const login = createLogin({ username: "onboarding-routine" });
    const profile = createTestProfile("Routine Starter", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, {
      ...initialOnboardingState(),
      status: "in_progress",
      profilePath: "self",
      focuses: ["fitness"],
      basicsComplete: true,
    });

    const adopted = await startOnboardingRoutine(
      fd({ template_id: "full-body-3x" })
    );
    expect(adopted).toMatchObject({ ok: true });
    expect(getActiveRoutine(profile.id)?.template_id).toBe("full-body-3x");
    expect(getRoutines(profile.id)).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM frequency_targets
            WHERE profile_id = ? AND scope_kind IN ('region','group','type')`
        )
        .get(profile.id)
    ).toEqual({ count: 2 });

    const needsConfirmation = await startOnboardingRoutine(
      fd({ template_id: "bodyweight-minimal" })
    );
    expect(needsConfirmation).toMatchObject({
      ok: false,
      needsConfirmation: true,
    });
    expect(getRoutines(profile.id)).toHaveLength(1);

    const replaced = await startOnboardingRoutine(
      fd({
        template_id: "bodyweight-minimal",
        confirm_replace: "yes",
      })
    );
    expect(replaced).toMatchObject({ ok: true });
    expect(getActiveRoutine(profile.id)?.template_id).toBe(
      "bodyweight-minimal"
    );
  });

  it("requires reviewing the data step but allows an explicit no-data continuation", async () => {
    const login = createLogin({ username: "onboarding-complete" });
    const profile = createTestProfile("First Value", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, {
      ...initialOnboardingState(),
      status: "in_progress",
      profilePath: "self",
      focuses: ["fitness"],
      basicsComplete: true,
      layoutReviewed: true,
      notificationIntent: "later",
      notificationsReviewed: true,
    });

    await redirected(completeOnboarding());
    expect(getOnboardingState(profile.id)?.status).toBe("in_progress");

    await redirected(continueOnboardingData());
    expect(getOnboardingState(profile.id)?.dataReviewed).toBe(true);
    await redirected(completeOnboarding());
    expect(getOnboardingState(profile.id)?.status).toBe("complete");
  });

  it("persists layout review and notification intent before completion", async () => {
    const login = createLogin({ username: "onboarding-review" });
    const profile = createTestProfile("Review Person", login.id);
    actAs(login, profile);
    setOnboardingState(profile.id, {
      ...initialOnboardingState(),
      status: "in_progress",
      profilePath: "caregiving",
      focuses: ["medications"],
      basicsComplete: true,
      dataReviewed: true,
    });

    const layout = new FormData();
    layout.append("widget", "next-appointment");
    layout.append("widget", "coaching-observations");
    await redirected(saveOnboardingDashboard(layout));
    expect(getOnboardingState(profile.id)?.layoutReviewed).toBe(true);
    expect(getDashboardLayout(profile.id)?.hidden).toContain("recent-labs");

    await redirected(
      saveOnboardingNotifications(fd({ notification_intent: "safety-only" }))
    );
    expect(getOnboardingState(profile.id)).toMatchObject({
      notificationIntent: "safety-only",
      notificationsReviewed: true,
    });
    expect(getNotifySchedule(profile.id)).toMatchObject({
      workoutEnabled: false,
      digestHour: null,
      preventiveEnabled: false,
    });

    await redirected(
      saveOnboardingNotifications(fd({ notification_intent: "none" }))
    );
    expect(getNotifySchedule(profile.id).supplementHours).toEqual({
      Morning: null,
      Midday: null,
      Evening: null,
      Bedtime: null,
    });

    await redirected(
      saveOnboardingNotifications(fd({ notification_intent: "safety-only" }))
    );
    expect(getNotifySchedule(profile.id).supplementHours).toEqual({
      Morning: 8,
      Midday: 13,
      Evening: 20,
      Bedtime: 22,
    });
  });

  it("does not persist fitness widgets hidden by the dashboard age gate", async () => {
    const login = createLogin({ username: "onboarding-restricted-layout" });
    const profile = createTestProfile("Restricted Layout", login.id);
    actAs(login, profile);
    setMinTrainingAge(18);
    setUserBirthdate(profile.id, "2018-01-01");
    setOnboardingState(profile.id, {
      ...initialOnboardingState(),
      status: "in_progress",
      profilePath: "self",
      focuses: ["fitness"],
      basicsComplete: true,
      dataReviewed: true,
    });

    const layout = new FormData();
    layout.append("widget", "recent-labs");
    layout.append("widget", "coaching");
    layout.append("widget", "goals-habits");
    await redirected(saveOnboardingDashboard(layout));

    expect(getDashboardLayout(profile.id)?.order).not.toContain("coaching");
    expect(getDashboardLayout(profile.id)?.order).not.toContain("goals-habits");
    expect(getDashboardLayout(profile.id)?.order).toContain("recent-labs");
  });
});
