"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getAccessibleProfiles,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import { db, today, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { customizableWidgetDefs } from "@/lib/dashboard-widgets";
import { isTrainingRestricted } from "@/lib/age-gate";
import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";
import {
  completeOnboardingState,
  hasOnboardingFirstValue,
  initialOnboardingState,
  isOnboardingNotificationIntent,
  onboardingNotificationSchedule,
  onboardingDeferred,
  onboardingDashboardLayout,
  onboardingWithBasics,
  onboardingWithDataReviewed,
  onboardingWithFocuses,
  onboardingWithLayout,
  onboardingWithNotificationIntent,
  onboardingWithProfilePath,
  type OnboardingProfilePath,
  type OnboardingStep,
} from "@/lib/onboarding";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import { reconcileFlags } from "@/lib/queries";
import { getRoutineTemplate } from "@/lib/routine-templates";
import {
  activateRoutine,
  adoptTemplate,
  getTrainingTargetsToReplace,
} from "@/lib/routines";
import {
  getOnboardingState,
  getNotifySchedule,
  getTimezone,
  getUserBirthdate,
  getUserSex,
  isValidTimezone,
  setDashboardLayout,
  setOnboardingState,
  setNotifySchedule,
  setStoredAge,
  setTimezone,
  getUnitPrefs,
  setUnitPrefs,
  setUserBirthdate,
  setUserSex,
  type DistanceUnit,
  type WeightUnit,
} from "@/lib/settings";
import type { Sex } from "@/lib/types";

function onboardingError(message: string, step: OnboardingStep): never {
  redirect(`/onboarding?step=${step}&error=${encodeURIComponent(message)}`);
}

export type OnboardingRoutineResult =
  | { ok: true; routineId: number; routineName: string }
  | { ok: false; error: string; needsConfirmation?: boolean };

// The Training onboarding branch is a thin entry point into the SAME #738
// adopt/activate cores used by Training → Routines. Beginner templates only: the
// full catalog and custom builder remain available on the Training page.
export async function startOnboardingRoutine(
  formData: FormData
): Promise<OnboardingRoutineResult> {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state?.focuses.includes("fitness")) {
    return { ok: false, error: "Choose fitness as a priority first." };
  }

  const templateId = String(formData.get("template_id") ?? "").trim();
  const template = getRoutineTemplate(templateId);
  if (!template || template.audience !== "beginner") {
    return { ok: false, error: "Choose an available starter routine." };
  }

  const targetsToReplace = getTrainingTargetsToReplace(profile.id);
  if (
    targetsToReplace.length > 0 &&
    formData.get("confirm_replace") !== "yes"
  ) {
    return {
      ok: false,
      error: "Confirm replacing your current training targets.",
      needsConfirmation: true,
    };
  }

  const routineId = writeTx(() => {
    const adoptedId = adoptTemplate(profile.id, template.id);
    if (!activateRoutine(profile.id, adoptedId)) {
      throw new Error("The adopted routine could not be activated.");
    }
    return adoptedId;
  });

  revalidatePath("/");
  revalidatePath("/onboarding");
  revalidatePath("/training");
  return { ok: true, routineId, routineName: template.name };
}

export async function dismissOnboardingChecklist() {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state || state.status !== "complete") return;
  setOnboardingState(profile.id, { ...state, checklistDismissed: true });
  revalidatePath("/");
}

export async function saveOnboardingProfilePath(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const raw = formData.get("profile_path");
  const profilePath: OnboardingProfilePath | null =
    raw === "self" || raw === "caregiving" ? raw : null;
  if (!profilePath) onboardingError("Choose who this profile is for.", 1);

  const state = getOnboardingState(profile.id) ?? initialOnboardingState();
  setOnboardingState(
    profile.id,
    onboardingWithProfilePath(state, profilePath, new Date().toISOString())
  );
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/onboarding?step=2");
}

export async function deferOnboarding() {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id) ?? initialOnboardingState();
  setOnboardingState(
    profile.id,
    onboardingDeferred(state, new Date().toISOString())
  );
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/");
}

export async function saveOnboardingFocuses(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id) ?? initialOnboardingState();
  if (!state.profilePath)
    onboardingError("Choose who this profile is for first.", 2);
  const next = onboardingWithFocuses(
    state,
    formData.getAll("focus"),
    new Date().toISOString()
  );
  if (next.focuses.length === 0) {
    onboardingError("Choose one or two outcomes to continue.", 2);
  }

  writeTx(() => {
    setOnboardingState(profile.id, next);
    setDashboardLayout(profile.id, onboardingDashboardLayout(next.focuses));
  });
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect(`/onboarding?step=${state.basicsComplete ? 4 : 3}`);
}

export async function saveOnboardingDashboard(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state || !state.basicsComplete || state.focuses.length === 0) {
    onboardingError("Finish the earlier setup steps first.", 5);
  }
  if (!state.dataReviewed && !(await selectedOnboardingDataExists(state))) {
    onboardingError("Review the data step before shaping your dashboard.", 4);
  }

  const eligible = customizableWidgetDefs(isTrainingRestricted(profile.id));
  const eligibleIds = new Set(eligible.map((widget) => widget.id));
  const requested = new Set(formData.getAll("widget").map(String));
  const visible = eligible
    .filter((widget) => requested.has(widget.id))
    .map((widget) => widget.id);
  if (visible.length === 0) {
    onboardingError("Keep at least one dashboard card visible.", 5);
  }

  const recommended = onboardingDashboardLayout(state.focuses);
  const recommendedOrder = [
    ...recommended.order.filter((id) => eligibleIds.has(id)),
    ...eligible
      .map((widget) => widget.id)
      .filter((id) => !recommended.order.includes(id)),
  ];
  const order = [
    ...recommendedOrder.filter((id) => visible.includes(id)),
    ...recommendedOrder.filter((id) => !visible.includes(id)),
  ];
  const nextState = onboardingWithLayout(state, new Date().toISOString());
  writeTx(() => {
    setDashboardLayout(profile.id, {
      order,
      hidden: eligible
        .map((widget) => widget.id)
        .filter((id) => !visible.includes(id)),
    });
    setOnboardingState(profile.id, nextState);
  });
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/onboarding?step=6");
}

export async function continueOnboardingData() {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state || !state.basicsComplete || state.focuses.length === 0) {
    onboardingError("Finish the earlier setup steps first.", 4);
  }
  setOnboardingState(
    profile.id,
    onboardingWithDataReviewed(state, new Date().toISOString())
  );
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/onboarding?step=5");
}

export async function saveOnboardingNotifications(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state || !state.layoutReviewed) {
    onboardingError("Review the dashboard layout first.", 6);
  }

  const intent = formData.get("notification_intent");
  if (!isOnboardingNotificationIntent(intent)) {
    onboardingError("Choose a notification preference.", 6);
  }
  writeTx(() => {
    setNotifySchedule(
      profile.id,
      onboardingNotificationSchedule(
        intent,
        getNotifySchedule(profile.id),
        state.notificationIntent
      )
    );
    setOnboardingState(
      profile.id,
      onboardingWithNotificationIntent(state, intent, new Date().toISOString())
    );
  });
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/onboarding?step=7");
}

export async function saveOnboardingBasics(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (!state || state.focuses.length === 0) {
    onboardingError("Choose what you want Allos to help with first.", 3);
  }

  const displayName = String(formData.get("display_name") ?? "").trim();
  if (!displayName) onboardingError("Enter a display name.", 3);
  if (displayName.length > 60) onboardingError("Display name is too long.", 3);

  const sexRaw = String(formData.get("sex") ?? "");
  const sex: Sex | null =
    sexRaw === "male" ? "male" : sexRaw === "female" ? "female" : null;

  const birthdateRaw = String(formData.get("birthdate") ?? "").trim();
  const birthdate = birthdateRaw || null;
  if (
    birthdate &&
    (!isRealIsoDate(birthdate) || birthdate > today(profile.id))
  ) {
    onboardingError("Enter a valid birthdate that is not in the future.", 3);
  }

  const ageRaw = String(formData.get("age") ?? "").trim();
  const age = ageRaw === "" ? null : Number(ageRaw);
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 149)) {
    onboardingError("Approximate age must be a whole number from 1 to 149.", 3);
  }

  const timezone = String(formData.get("timezone") ?? "").trim();
  if (!isValidTimezone(timezone))
    onboardingError("Choose a valid timezone.", 3);

  const weightUnit: WeightUnit =
    formData.get("weight_unit") === "lb" ? "lb" : "kg";
  const distanceUnit: DistanceUnit =
    formData.get("distance_unit") === "mi" ? "mi" : "km";
  const previousTimezone = getTimezone(profile.id);
  const demographicsChanged =
    sex !== getUserSex(profile.id) ||
    birthdate !== getUserBirthdate(profile.id);
  const nextState = onboardingWithBasics(state, new Date().toISOString());

  writeTx(() => {
    db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(
      displayName,
      profile.id
    );
    setUserSex(profile.id, sex);
    setUserBirthdate(profile.id, birthdate);
    setStoredAge(profile.id, birthdate ? null : age);
    setTimezone(profile.id, timezone);
    // Onboarding collects weight + distance; preserve the login's temperature unit
    // (default °F, changeable under Settings → Preferences — #857).
    setUnitPrefs(login.id, {
      weightUnit,
      distanceUnit,
      temperatureUnit: getUnitPrefs(login.id).temperatureUnit,
    });
    setOnboardingState(profile.id, nextState);
  });

  if (previousTimezone !== timezone) {
    sweepIngestWindowForTimezoneChange(profile.id);
  }
  if (demographicsChanged) reconcileFlags(profile.id);

  revalidatePath("/", "layout");
  revalidatePath("/onboarding");
  redirect("/onboarding?step=4");
}

export async function completeOnboarding() {
  const { profile } = await requireWriteAccess();
  const state = getOnboardingState(profile.id);
  if (
    !state ||
    !state.profilePath ||
    state.focuses.length === 0 ||
    !state.basicsComplete ||
    !state.layoutReviewed ||
    !state.notificationsReviewed
  ) {
    onboardingError("Finish the outcome and profile steps first.", 7);
  }

  if (!state.dataReviewed && !(await selectedOnboardingDataExists(state))) {
    onboardingError("Review the data step before finishing setup.", 4);
  }

  setOnboardingState(
    profile.id,
    completeOnboardingState(state, new Date().toISOString())
  );
  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/");
}

async function selectedOnboardingDataExists(
  state: NonNullable<ReturnType<typeof getOnboardingState>>
): Promise<boolean> {
  const { profile } = await requireSession();
  const accessible = await getAccessibleProfiles();
  return hasOnboardingFirstValue(state.focuses, {
    ...getOnboardingDataPresence(profile.id),
    caregiving: accessible.length > 1,
  });
}
