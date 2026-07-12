"use server";
// Active-profile settings actions — the Profile tab (Settings → Profile). Split
// out of app/(app)/settings/actions.ts by auth tier (#319): every action here
// gates on requireWriteAccess() (properties of the tracked person, editable by any
// login with write access to the active profile). Re-exported from ../actions for
// back-compat import paths.
import { requireWriteAccess } from "@/lib/auth";
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
  setProfileTelegram,
  setNotifySchedule,
  setProfileHomeAssistant,
  isValidTimezone,
  setTimezone,
  isValidWeekStart,
  setWeekStart,
  isValidWeekMode,
  setWeekMode,
  setEmergencyCardEnabled,
  setBloodType,
  setEmergencyContact,
  setSmokingHistory,
  setMaxHrOverride,
  setZone2WeeklyTargetMin,
} from "@/lib/settings";
import {
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
} from "@/lib/smoking";
import { reconcileFlags } from "@/lib/queries";
import { dispatch } from "@/lib/notifications";
import { sendHomeAssistantTest } from "@/lib/notifications/home-assistant";
import {
  isValidWebhookUrl,
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

  // Both sex and reproductive status feed the reference-range selection, so a
  // change to either re-reconciles the flags and refreshes the biomarker views.
  if (sexChanged || rsChanged) {
    reconcileFlags(profile.id);
    revalidatePath("/biomarkers");
    revalidatePath("/biomarkers/view", "page");
  }

  // Birthdate (ISO YYYY-MM-DD); the profile's age is derived from it. An <input
  // type="date"> emits either a valid date or "". Setting a birthdate also
  // clears any stored age fallback (handled in setUserBirthdate).
  const bdRaw = String(formData.get("birthdate") ?? "").trim();
  const birthdate = /^\d{4}-\d{2}-\d{2}$/.test(bdRaw) ? bdRaw : null;
  if (birthdate !== getUserBirthdate(profile.id))
    setUserBirthdate(profile.id, birthdate);

  // Manual age is editable only while no birthdate is set (a birthdate always
  // derives the age and clears this). Blank clears the fallback; an invalid
  // number is ignored so a fat-fingered entry can't wipe a good value.
  if (!birthdate) {
    const ageRaw = String(formData.get("age") ?? "").trim();
    if (ageRaw === "") {
      if (getStoredAge(profile.id) !== null) setStoredAge(profile.id, null);
    } else {
      const age = Number(ageRaw);
      if (
        Number.isInteger(age) &&
        age > 0 &&
        age < 150 &&
        age !== getStoredAge(profile.id)
      )
        setStoredAge(profile.id, age);
    }
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
  if (tz && isValidTimezone(tz)) setTimezone(profile.id, tz);

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

// ---- Smoking history (profile scope, issue #83) ----
// The structured smoking record (status / pack-years / quit year) — a property of
// the tracked person, so profile-scoped; any login with write access to the profile
// may edit it. Marks the entry 'manual' so a later CCD re-import never clobbers it.
// pack-years apply only to an ever-smoker and the quit year only to a former smoker
// (the setter drops the rest); the assessor uses this to activate the risk-gated
// lung LDCT / AAA screening reminders.
export async function saveSmokingHistory(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const status = parseSmokingStatus(
    String(formData.get("smoking_status") ?? "")
  );
  const packYears = parsePackYears(String(formData.get("pack_years") ?? ""));
  // Bound the quit year to a real, non-future year; parseQuitYear already rejects
  // an out-of-range value, and a future year is meaningless for "quit N years ago".
  const thisYear = new Date().getFullYear();
  const quitYearRaw = parseQuitYear(String(formData.get("quit_year") ?? ""));
  const quitYear =
    quitYearRaw != null && quitYearRaw <= thisYear ? quitYearRaw : null;

  setSmokingHistory(profile.id, { status, packYears, quitYear });
  // The record drives the preventive reminders (Upcoming) and the profile page.
  revalidatePath("/upcoming");
  revalidatePath("/settings/profile");
}

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

// ---- Emergency card (profile scope, issue #42) ----

// The offline emergency card opt-in, manual blood type, and emergency contact —
// all properties of the tracked person, so profile-scoped (any login acting as the
// profile may edit them). setBloodType normalizes/validates the value; a blank or
// unrecognized blood type clears it.
export async function saveEmergencyCardSettings(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const enabledRaw = formData.get("emergency_enabled");
  setEmergencyCardEnabled(
    profile.id,
    enabledRaw === "1" || enabledRaw === "on"
  );
  setBloodType(profile.id, String(formData.get("blood_type") ?? ""));
  setEmergencyContact(profile.id, {
    name: String(formData.get("emergency_contact_name") ?? ""),
    phone: String(formData.get("emergency_contact_phone") ?? ""),
    relation: String(formData.get("emergency_contact_relation") ?? ""),
  });
  revalidatePath("/settings/profile");
  revalidatePath("/emergency");
}

// ---- Notifications: profile delivery target (profile scope) ----

// The per-profile parts of notifications: whether reminders are on for this
// profile, the chat they're sent to, and the send schedule. The global bot
// credentials are set separately (admin-only, see saveTelegramBotConfig).
export async function saveNotificationPrefs(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const enabledRaw = formData.get("telegram_enabled");
  setProfileTelegram(profile.id, {
    telegramEnabled: enabledRaw === "on" || enabledRaw === "1",
    telegramChatId: String(formData.get("telegram_chat_id") ?? ""),
  });

  // Per-slot send schedule. "" / "off" → that window is disabled.
  const hour = (key: string): number | null => {
    const raw = String(formData.get(key) ?? "").trim();
    if (raw === "" || raw === "off") return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
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
