"use server";
// Active-profile settings actions — the Profile tab (Settings → Profile). Split
// out of app/(app)/settings/actions.ts by auth tier (#319): every action here
// gates on requireWriteAccess() (properties of the tracked person, editable by any
// login with write access to the active profile). Re-exported from ../actions for
// back-compat import paths.
import { requireWriteAccess, requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  getUserSex,
  setUserSex,
  getUserBirthdate,
  setUserBirthdate,
  getUserFullName,
  setUserFullName,
  getUserReproductiveStatus,
  setUserReproductiveStatus,
  getStoredAge,
  setStoredAge,
  getUserAge,
  getTimezone,
  getProfileTelegram,
  setProfileTelegram,
  getTelegramBotConfig,
  getFoodTelegramPrompted,
  setFoodTelegramPrompted,
  setProfileFoodTelegram,
  setNotifySchedule,
  getProfileHomeAssistant,
  setProfileHomeAssistant,
  setProfileTelegramDisabledKinds,
  setExcludedFoodGroups,
  isValidTimezone,
  setTimezone,
  setHomeLocation,
  isValidWeekStart,
  setWeekStart,
  isValidWeekMode,
  setWeekMode,
  setMaxHrOverride,
  setZone2WeeklyTargetMin,
  setRecommendationCadence,
  setMentalHealthShareFull,
  setProfileCrisisResourcesOverride,
} from "@/lib/settings";
import { parseCrisisResourcesText } from "@/lib/crisis-resources";
import { parseCadence } from "@/lib/recommendation-run";
import { parseHome } from "@/lib/home-location";
import { reconcileFlags } from "@/lib/queries";
import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";
import { dispatch } from "@/lib/notifications";
import { sendFoodOptInPrompt } from "@/lib/notifications/food";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import {
  WAKING_START_HOUR,
  WAKING_END_HOUR,
} from "@/lib/notifications/schedule";
import { sendHomeAssistantTest } from "@/lib/notifications/home-assistant";
import {
  isValidWebhookUrl,
  parseDisabledKinds,
  TOGGLEABLE_HA_KINDS,
} from "@/lib/notifications/home-assistant-core";
import type { NotificationKind } from "@/lib/notifications/types";
import type { ReproductiveStatus, Sex } from "@/lib/types";

// ---- Profile scope (follows the active profile) ----

// Biological sex, birthdate/age, and timezone are properties of the tracked
// person, so they're keyed by profile.id. Any login acting as the profile may
// edit them (members included).
export async function saveProfileSettings(formData: FormData) {
  const { profile } = await requireWriteAccess();

  // Biological sex: drives sex-specific optimal biomarker bands. When it
  // changes, re-derive the stored non-optimal flags so the records table and
  // range filters reflect the new optimal ranges.
  const raw = formData.get("sex");
  const sex: Sex | null =
    raw === "male" ? "male" : raw === "female" ? "female" : null;
  const sexChanged = sex !== getUserSex(profile.id);
  if (sexChanged) setUserSex(profile.id, sex);

  // Reproductive (menopausal) status — female physiology only. Only accept a value
  // when the sex is female; otherwise force null so switching away from female
  // clears any stale status. Like sex, a change re-derives the stored hormone flags.
  const rsRaw = formData.get("reproductive_status");
  const reproductiveStatus: ReproductiveStatus | null =
    sex === "female" &&
    (rsRaw === "premenopausal" || rsRaw === "postmenopausal")
      ? rsRaw
      : null;
  const rsChanged =
    reproductiveStatus !== getUserReproductiveStatus(profile.id);
  if (rsChanged) setUserReproductiveStatus(profile.id, reproductiveStatus);

  // Birthdate (ISO YYYY-MM-DD); the profile's age is derived from it. An <input
  // type="date"> emits either a valid date or "". Setting a birthdate also
  // clears any stored age fallback (handled in setUserBirthdate).
  const bdRaw = String(formData.get("birthdate") ?? "").trim();
  const birthdate = /^\d{4}-\d{2}-\d{2}$/.test(bdRaw) ? bdRaw : null;
  const birthdateChanged = birthdate !== getUserBirthdate(profile.id);
  if (birthdateChanged) setUserBirthdate(profile.id, birthdate);

  // Manual age is editable only while no birthdate is set (a birthdate always
  // derives the age and clears this). Blank clears the fallback; an invalid
  // number is ignored so a fat-fingered entry can't wipe a good value.
  let ageChanged = false;
  if (!birthdate) {
    const ageRaw = String(formData.get("age") ?? "").trim();
    if (ageRaw === "") {
      if (getStoredAge(profile.id) !== null) {
        setStoredAge(profile.id, null);
        ageChanged = true;
      }
    } else {
      const age = Number(ageRaw);
      if (
        Number.isInteger(age) &&
        age > 0 &&
        age < 150 &&
        age !== getStoredAge(profile.id)
      ) {
        setStoredAge(profile.id, age);
        ageChanged = true;
      }
    }
  }

  // Sex, reproductive status, AND age all feed the age-banded / sex-specific
  // reference-range selection, so a change to ANY of them re-reconciles the stored
  // flags and refreshes the biomarker views (#628). Age matters because 26 analytes
  // carry ranges_by_age: filling in a child's birthdate later must recompute a
  // reading flagged against the adult fallback band to its correct pediatric band —
  // reconcileFlags recomputes each historical reading against its own reading-date
  // age (ageForRecord), so the trigger is all that's needed. Runs after birthdate/
  // age are persisted so the reconcile reads the new demographics.
  if (sexChanged || rsChanged || birthdateChanged || ageChanged) {
    reconcileFlags(profile.id);
    revalidatePath("/biomarkers");
    revalidatePath("/biomarkers/view", "page");
  }

  // Full/legal name of the tracked person — distinct from the profile's display
  // name. Blank clears it. (Only save when the field was submitted, so callers
  // that don't render it can't wipe an adopted value.)
  if (formData.has("full_name")) {
    const fullName = String(formData.get("full_name") ?? "").trim();
    if (fullName !== (getUserFullName(profile.id) ?? ""))
      setUserFullName(profile.id, fullName || null);
  }

  // Timezone defines "today" for this profile (day-window queries, streaks,
  // reminders). Ignore an invalid value rather than throwing — keep the prior
  // setting.
  const tz = String(formData.get("timezone") ?? "").trim();
  if (tz && isValidTimezone(tz)) {
    const prevTz = getTimezone(profile.id);
    if (tz !== prevTz) {
      setTimezone(profile.id, tz);
      // The ingest tables that store profile-LOCAL time computed at ingest
      // (hr_minutes.ts and Health Connect body_metrics.date) re-key on a timezone
      // change, so the next rolling-window push would duplicate ~48h of data under the
      // shifted keys (#608). Sweep the current window's push-sourced rows so the next
      // push repopulates them cleanly under the new keys.
      sweepIngestWindowForTimezoneChange(profile.id);
    }
  }

  // Home location (issue #570): the coarse "where am I" coordinates that drive sun /
  // daylight features. Gated on the field's presence so a form that doesn't render it
  // never wipes an adopted value. Both blank → CLEAR; a valid pair → stored coarse
  // (setHomeLocation rounds to ~11 km); an invalid/partial pair is ignored (prior
  // value kept). Home location is PHI-adjacent — never logged.
  if (formData.has("home_lat") || formData.has("home_lng")) {
    const latRaw = String(formData.get("home_lat") ?? "").trim();
    const lngRaw = String(formData.get("home_lng") ?? "").trim();
    if (latRaw === "" && lngRaw === "") {
      setHomeLocation(profile.id, null);
    } else {
      const home = parseHome(latRaw, lngRaw);
      if (home) setHomeLocation(profile.id, home);
    }
  }

  // Week start (0=Sun … 6=Sat): where calendars break and, in calendar mode, when
  // the weekly-routine counters reset. Ignore a missing/empty/out-of-range value
  // rather than letting Number(null)===0 silently force Sunday.
  const wsRaw = String(formData.get("week_start") ?? "").trim();
  const ws = Number(wsRaw);
  if (wsRaw !== "" && isValidWeekStart(ws)) setWeekStart(profile.id, ws);

  // Weekly counting mode: calendar week vs rolling 7 days for the routine
  // counters and the journal week summary. Ignore an unrecognized value.
  const wm = String(formData.get("week_mode") ?? "").trim();
  if (isValidWeekMode(wm)) setWeekMode(profile.id, wm);

  // These affect display across the whole app.
  revalidatePath("/", "layout");
}

// Smoking history (#83) and health risk factors (#517) moved to the Medical
// surface (/medical/background) with the emergency card (#928 — data about the
// person, not configuration; the #343 equipment precedent). Their write cores live
// in app/(app)/medical/background/actions.ts, still profile-scoped + requireWriteAccess.

// ---- Training HR zones (profile scope, issue #159) ----

// The manual max-HR override (bpm) and the weekly Zone 2 minutes target that drive
// the Trends → Fitness intensity-distribution view. Both profile-scoped properties
// of the tracked person; any login with write access may edit them. A blank/zero
// max-HR clears the override (falls back to the age formula); a blank Zone 2 target
// leaves the stored value untouched (its getter supplies the default).
export async function saveTrainingZones(formData: FormData) {
  const { profile } = await requireWriteAccess();

  const maxHrRaw = String(formData.get("max_hr_override") ?? "").trim();
  if (maxHrRaw === "") {
    setMaxHrOverride(profile.id, null);
  } else {
    const bpm = Number(maxHrRaw);
    // Guard an implausible entry rather than storing junk; a real max HR sits well
    // inside this band. Out-of-range input is ignored (keeps the prior value).
    if (Number.isFinite(bpm) && bpm >= 100 && bpm <= 240) {
      setMaxHrOverride(profile.id, Math.round(bpm));
    }
  }

  const targetRaw = String(
    formData.get("zone2_weekly_target_min") ?? ""
  ).trim();
  if (targetRaw !== "") {
    const min = Number(targetRaw);
    if (Number.isFinite(min) && min >= 0 && min <= 5000) {
      setZone2WeeklyTargetMin(profile.id, Math.round(min));
    }
  }

  revalidatePath("/settings/profile");
  revalidatePath("/trends");
}

// Dietary preferences (#975) — the profile's excluded food-group set. Profile-scoped,
// member-editable (a property of the tracked person). The write core normalizes to
// canonical catalog slugs (dropping any unknown slug), so a forged post can't store junk;
// an empty set clears the row (Omnivore). Revalidates the nutrition surfaces the set
// filters/demotes.
export async function saveDietaryPreferences(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const slugs = formData.getAll("excluded").map((v) => String(v));
  setExcludedFoodGroups(profile.id, slugs);
  revalidatePath("/settings/profile");
  revalidatePath("/nutrition");
  return { ok: true };
}

// Emergency card settings (#42) moved to the Medical surface (/medical/background)
// with smoking history + risk factors (#928). Write core in
// app/(app)/medical/background/actions.ts, still profile-scoped + requireWriteAccess.

// ---- Notifications: profile delivery target (profile scope) ----

// The per-profile parts of notifications: whether reminders are on for this
// profile, the chat they're sent to, and the send schedule. The global bot
// credentials are set separately (admin-only, see saveTelegramBotConfig).
export async function saveNotificationPrefs(formData: FormData) {
  const { profile } = await requireWriteAccess();

  // Whether the profile's Telegram was fully connectable BEFORE this save, so we can
  // detect a first connection and offer the one-time food-logging opt-in prompt (#682).
  const before = getProfileTelegram(profile.id);
  const wasConfigured = before.telegramEnabled && before.telegramChatId !== "";

  const enabledRaw = formData.get("telegram_enabled");
  setProfileTelegram(profile.id, {
    telegramEnabled: enabledRaw === "on" || enabledRaw === "1",
    telegramChatId: String(formData.get("telegram_chat_id") ?? ""),
  });

  // Food logging over Telegram (#682): the per-profile opt-in toggle. Gated on the
  // field's presence so a form that doesn't render it can't wipe the setting.
  if (formData.has("food_telegram_enabled")) {
    const v = formData.get("food_telegram_enabled");
    setProfileFoodTelegram(profile.id, v === "on" || v === "1");
  }

  // First-connection prompt: the first time this profile becomes fully connectable
  // (enabled + chat id + a bot token exists) and we haven't asked before, send a
  // one-time "want to log food too?" message with Enable/No-thanks buttons, and mark
  // it prompted so it never re-nags. Skipped for a life stage where food logging is
  // hidden (infant). Best-effort — a send failure must never fail the settings save.
  const after = getProfileTelegram(profile.id);
  const botConfigured = getTelegramBotConfig().telegramBotToken !== "";
  const nowConfigured =
    after.telegramEnabled && after.telegramChatId !== "" && botConfigured;
  if (
    nowConfigured &&
    !wasConfigured &&
    !getFoodTelegramPrompted(profile.id) &&
    isFoodLoggingRelevant(getUserAge(profile.id))
  ) {
    setFoodTelegramPrompted(profile.id);
    try {
      await sendFoodOptInPrompt(profile.id);
    } catch {
      // A failed prompt send is non-critical (the toggle still lives in Settings);
      // the prompted marker is already set so we don't retry-spam on the next save.
    }
  }

  // Per-slot send schedule. "" / "off" → that window is disabled.
  const hour = (key: string): number | null => {
    const raw = String(formData.get(key) ?? "").trim();
    if (raw === "" || raw === "off") return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  // A required 0-23 hour with a fallback (the quiet-hours bounds are never "off" —
  // there is always a waking window; the widest is 0→23).
  const wakingHour = (key: string, fallback: number): number => {
    const raw = String(formData.get(key) ?? "").trim();
    const n = Number(raw);
    return raw !== "" && Number.isInteger(n) && n >= 0 && n <= 23
      ? n
      : fallback;
  };
  setNotifySchedule(profile.id, {
    supplementHours: {
      Morning: hour("supp_morning_hour"),
      Midday: hour("supp_midday_hour"),
      Evening: hour("supp_evening_hour"),
      Bedtime: hour("supp_bedtime_hour"),
    },
    workoutEnabled:
      formData.get("workout_enabled") === "on" ||
      formData.get("workout_enabled") === "1",
    // Morning digest: "" / "off" → off.
    digestHour: hour("digest_hour"),
    // Weekly recap (#32): weekday 0-6, "" / "off" → off.
    weeklyRecapDay: (() => {
      const raw = String(formData.get("recap_day") ?? "").trim();
      if (raw === "" || raw === "off") return null;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
    })(),
    weeklyRecapHour: hour("recap_hour") ?? 9,
    // Milestone alerts (#32): default on.
    milestonesEnabled:
      formData.get("milestones_enabled") === "on" ||
      formData.get("milestones_enabled") === "1",
    // Preventive-care reminders (#87): default on.
    preventiveEnabled:
      formData.get("preventive_enabled") === "on" ||
      formData.get("preventive_enabled") === "1",
    // Quiet hours (#450): the waking-window bounds for non-urgent episode nudges.
    // A blank/invalid field falls back to the default so a malformed submit can't
    // silence the profile; wrap-around (start > end) is allowed for night shifts.
    wakingStartHour: wakingHour("waking_start_hour", WAKING_START_HOUR),
    wakingEndHour: wakingHour("waking_end_hour", WAKING_END_HOUR),
  });
  revalidatePath("/settings/profile");
}

export async function sendTestNotification(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { profile } = await requireWriteAccess();
  const results = await dispatch(profile.id, {
    title: "Test notification",
    body: "Notifications are working ✅",
    kind: "test",
  });
  if (results.length === 0)
    return {
      ok: false,
      message:
        "No channel configured — check “Enable Telegram notifications”, fill in your chat id, and ask an admin to set the bot token on Settings → Server.",
    };
  const failed = results.filter((r) => !r.ok);
  if (failed.length)
    return {
      ok: false,
      message: failed.map((f) => `${f.id}: ${f.error}`).join("; "),
    };
  return { ok: true, message: "Sent ✅ — check your Telegram." };
}

// ---- Notifications: Home Assistant channel (profile scope, issue #248) ----

// The per-profile Home Assistant webhook target: enable toggle, webhook URL,
// optional shared secret, and which notification kinds to forward (a household may
// want doses announced but not weekly recaps). Profile-scoped like the Telegram
// delivery target, so any login with write access to the profile may edit it.
// Rejects a malformed URL when enabling so a typo can't silently disable delivery.
export async function saveHomeAssistantPrefs(
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const enabled =
    formData.get("ha_enabled") === "on" || formData.get("ha_enabled") === "1";
  const webhookUrl = String(formData.get("ha_webhook_url") ?? "").trim();
  const secret = String(formData.get("ha_secret") ?? "").trim();

  if (enabled && !isValidWebhookUrl(webhookUrl)) {
    return {
      ok: false,
      error:
        "Enter a valid Home Assistant webhook URL (http(s)://host:8123/api/webhook/<id>).",
    };
  }

  // A checkbox per toggleable kind: checked ("1") = forward; the DISABLED set is the
  // kinds NOT checked. Absent field also reads as disabled (an unchecked box submits
  // nothing), so the form must render every kind.
  const disabledKinds: NotificationKind[] = TOGGLEABLE_HA_KINDS.filter(
    ({ kind }) => formData.get(`ha_kind_${kind}`) !== "1"
  ).map(({ kind }) => kind);

  setProfileHomeAssistant(profile.id, {
    enabled,
    webhookUrl,
    secret,
    disabledKinds,
  });
  revalidatePath("/settings/profile");
  return { ok: true };
}

// ---- Notification matrix columns (profile scope, issue #928) ----
// The kind × channel matrix on Settings → Notifications persists each column in its
// channel's tier store. The Telegram and Home Assistant columns are profile-scoped,
// so both gate on requireWriteAccess() like the rest of this module. The push column
// is login-scoped and lives in ../actions (savePushNotifyKinds). Each action takes
// the FULL disabled-kinds set for its column as a JSON `disabled_kinds` field,
// validated by the shared pure core (unknown kinds dropped). The HA action preserves
// the channel's enable/URL/secret and rewrites only the disabled set.

export async function saveTelegramNotifyKinds(
  formData: FormData
): Promise<{ ok: true }> {
  const { profile } = await requireWriteAccess();
  const disabled = parseDisabledKinds(
    String(formData.get("disabled_kinds") ?? "")
  );
  setProfileTelegramDisabledKinds(profile.id, disabled);
  revalidatePath("/settings/notifications");
  return { ok: true };
}

export async function saveHomeAssistantNotifyKinds(
  formData: FormData
): Promise<{ ok: true }> {
  const { profile } = await requireWriteAccess();
  const disabled = parseDisabledKinds(
    String(formData.get("disabled_kinds") ?? "")
  );
  const cur = getProfileHomeAssistant(profile.id);
  setProfileHomeAssistant(profile.id, { ...cur, disabledKinds: disabled });
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// The AI recommendation-run cadence for the active profile (issue #424). Value is
// per-profile, but ADMIN-EDITABLE ONLY — the admin pays for the API key — so this
// gates on requireAdmin() (a member's Profile tab renders the control read-only).
export async function saveRecommendationCadence(formData: FormData) {
  const { profile } = await requireAdmin();
  const cadence = parseCadence(String(formData.get("recommendation_cadence")));
  setRecommendationCadence(profile.id, cadence);
  revalidatePath("/settings/profile");
  return { ok: true };
}

// Shared-surface detail for this profile's MENTAL-HEALTH visits (#997). Off by
// default (minimal on the household strip + family calendar); the owner may opt in
// to show them in full detail on those shared surfaces.
export async function saveMentalHealthShareFull(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const on =
    formData.get("mental_health_share_full") === "1" ||
    formData.get("mental_health_share_full") === "on";
  setMentalHealthShareFull(profile.id, on);
  revalidatePath("/settings/profile");
  revalidatePath("/");
}

// Per-profile crisis-resources OVERRIDE (#996) for a mixed-region household. Empty
// clears the override (inherit the instance default). Private to the profile.
export async function saveProfileCrisisResources(formData: FormData) {
  const { profile } = await requireWriteAccess();
  setProfileCrisisResourcesOverride(
    profile.id,
    parseCrisisResourcesText(String(formData.get("crisis_resources") ?? ""))
  );
  revalidatePath("/settings/profile");
  revalidatePath("/crisis-resources");
}

// Send a test announcement to the profile's HA webhook, independent of the
// Telegram/push test (a household may run only HA). Reports the failure verbatim so
// a wrong URL / unreachable HA is visible.
export async function sendTestHomeAssistant(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { profile } = await requireWriteAccess();
  try {
    const result = await sendHomeAssistantTest(profile.id);
    if (result === "not-configured")
      return {
        ok: false,
        message:
          "No Home Assistant webhook configured — enable it and paste your HA webhook URL first.",
      };
    return { ok: true, message: "Sent ✅ — check Home Assistant." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
