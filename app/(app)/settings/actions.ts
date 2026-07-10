"use server";
import {
  requireSession,
  requireWriteAccess,
  requireAdmin,
  destroyOtherSessionsForCurrent,
  revokeSession,
} from "@/lib/auth";
import { checkPasswordStrength } from "@/lib/password-strength";
import {
  getLoginTotpState,
  beginTotpEnrollment,
  activateTotp,
  disableTotp,
  regenerateRecoveryCodes,
  verifyLoginSecondFactor,
} from "@/lib/two-factor";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  setUnitPrefs,
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
  getTelegramBotConfig,
  setProfileTelegram,
  setTelegramBotConfig,
  setNotifySchedule,
  getPublicUrl,
  setPublicUrl,
  isValidTimezone,
  setTimezone,
  setInstanceTimezone,
  isValidWeekStart,
  setWeekStart,
  isValidWeekMode,
  setWeekMode,
  setAiPrefs,
  getBackupSettings,
  setBackupSettings,
  setEmergencyCardEnabled,
  setBloodType,
  setEmergencyContact,
  setSmokingHistory,
  type DistanceUnit,
  type WeightUnit,
} from "@/lib/settings";
import {
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
} from "@/lib/smoking";
import { performBackup } from "@/lib/backup";
import { formatBytes } from "@/lib/format-bytes";
import { setMinTrainingAge } from "@/lib/age-gate";
import { reconcileFlags } from "@/lib/queries";
import { normalizePublicUrl } from "@/lib/public-url";
import { dispatch } from "@/lib/notifications";
import { setWebhook, deleteWebhook } from "@/lib/notifications/telegram";
import {
  ensureVapidKeys,
  savePushSubscription,
  deletePushSubscription,
  sendTestPushToLogin,
} from "@/lib/notifications/push";
import { parsePushSubscription } from "@/lib/notifications/push-core";
import type { ReproductiveStatus, Sex } from "@/lib/types";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";

const log = createLogger("settings");

// ---- Preferences (login scope) ----

// Unit display preferences belong to the signed-in login, not the active
// profile, so they're keyed by login.id and available to every login.
export async function saveUnitPrefs(formData: FormData) {
  const { login } = requireSession();
  const weightUnit = (
    formData.get("weight_unit") === "lb" ? "lb" : "kg"
  ) as WeightUnit;
  const distanceUnit = (
    formData.get("distance_unit") === "mi" ? "mi" : "km"
  ) as DistanceUnit;
  setUnitPrefs(login.id, { weightUnit, distanceUnit });
  // Units affect display across the whole app.
  revalidatePath("/", "layout");
}

// ---- Profile scope (follows the active profile) ----

// Biological sex, birthdate/age, and timezone are properties of the tracked
// person, so they're keyed by profile.id. Any login acting as the profile may
// edit them (members included).
export async function saveProfileSettings(formData: FormData) {
  const { profile } = requireWriteAccess();

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
  const { profile } = requireWriteAccess();
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

// ---- Emergency card (profile scope, issue #42) ----

// The offline emergency card opt-in, manual blood type, and emergency contact —
// all properties of the tracked person, so profile-scoped (any login acting as the
// profile may edit them). setBloodType normalizes/validates the value; a blank or
// unrecognized blood type clears it.
export async function saveEmergencyCardSettings(formData: FormData) {
  const { profile } = requireWriteAccess();
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

// ---- Change own password ----

// Available to every login (not admin-only): the caller changes their own
// password after proving they know the current one. On success every OTHER
// session for the login is signed out (a password change should evict any
// stale device) while the current session is kept alive.
export async function changeOwnPassword(
  formData: FormData
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { login } = requireSession();
  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  // Strength gate (issue #23): raised minimum + class-diversity + no-username,
  // applied everywhere a password is set.
  const strength = checkPasswordStrength(next, { username: login.username });
  if (!strength.ok) return { ok: false, error: strength.error };

  const row = db
    .prepare("SELECT password_hash FROM logins WHERE id = ?")
    .get(login.id) as { password_hash: string } | undefined;
  if (!row) return { ok: false, error: "Login not found." };
  if (!(await verifyPassword(current, row.password_hash)))
    return { ok: false, error: "Current password is incorrect." };

  const hash = await hashPassword(next);
  db.prepare("UPDATE logins SET password_hash = ? WHERE id = ?").run(
    hash,
    login.id
  );
  destroyOtherSessionsForCurrent(login.id);
  recordAudit({
    loginId: login.id,
    action: AUDIT_ACTIONS.passwordChange,
    target: String(login.id),
  });
  return { ok: true, message: "Password changed. Other devices signed out." };
}

// ---- Active sessions (login scope) ----

// Revoke one of the caller's own live sessions from the active-sessions list.
// revokeSession scopes the delete to login.id, so a forged/foreign id can only
// ever end one of the caller's sessions (or nothing).
export async function revokeSessionAction(formData: FormData) {
  const { login } = requireSession();
  const id = String(formData.get("session_id") ?? "");
  if (id) revokeSession(login.id, id);
  revalidatePath("/settings");
}

// "Sign out everywhere else": drop every session for this login except the one
// making the request. Standalone counterpart to the eviction that a password
// change triggers.
export async function signOutOtherSessions() {
  const { login } = requireSession();
  destroyOtherSessionsForCurrent(login.id);
  revalidatePath("/settings");
}

// ---- AI (global, admin-only) ----

export async function saveAiSettings(formData: FormData) {
  requireAdmin();
  // Accept both the "1" our client sends and a native checkbox's "on".
  const on = (key: string) => {
    const v = formData.get(key);
    return v === "1" || v === "on";
  };
  setAiPrefs({
    autoSupplementSuggestions: on("auto_supplement_suggestions"),
    autoInsights: on("auto_insights"),
  });
  revalidatePath("/settings/server");
}

// ---- Public URL (global, admin-only) ----
// Shared by Telegram webhook, Strava OAuth, Health Connect.

export async function savePublicUrl(
  formData: FormData
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  requireAdmin();
  const res = normalizePublicUrl(String(formData.get("public_url") ?? ""));
  if (!res.ok) return res;
  setPublicUrl(res.url);
  revalidatePath("/settings/server");
  revalidatePath("/data", "layout");
  return res;
}

// ---- Instance-default timezone (global, admin-only) ----
// Seeds new profiles and backstops any profile without its own timezone.

export async function saveInstanceTimezone(formData: FormData) {
  requireAdmin();
  const tz = String(formData.get("timezone") ?? "").trim();
  if (tz && isValidTimezone(tz)) setInstanceTimezone(tz);
  revalidatePath("/settings/server");
}

// ---- Automated backups (global, admin-only) ----
// Nightly SQLite snapshot config + on-demand snapshot. See lib/backup.ts.

export async function saveBackupSettings(formData: FormData) {
  requireAdmin();
  const on = (key: string) => {
    const v = formData.get(key);
    return v === "1" || v === "on";
  };
  const num = (key: string, fallback: number) => {
    const n = Number(formData.get(key));
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const prev = getBackupSettings();
  setBackupSettings({
    enabled: on("backup_enabled"),
    hour: (() => {
      const h = num("backup_hour", prev.hour);
      return h >= 0 && h <= 23 ? h : prev.hour;
    })(),
    keepDaily: num("backup_keep_daily", prev.keepDaily),
    keepWeekly: num("backup_keep_weekly", prev.keepWeekly),
  });
  revalidatePath("/settings/server");
}

// On-demand snapshot. Surfaces the created file (name + size) or the failure —
// e.g. a full disk — rather than failing silently.
export async function backupNow(): Promise<{
  ok: boolean;
  message: string;
}> {
  requireAdmin();
  try {
    const { name, size, verification } = performBackup();
    revalidatePath("/settings/server");
    if (verification.integrity !== "ok") {
      // The snapshot wrote but failed PRAGMA integrity_check — don't report it as
      // a clean backup (performBackup already recorded the error and kept older
      // good snapshots).
      return {
        ok: false,
        message: `Backup ${name} failed integrity check: ${verification.detail ?? "corrupt snapshot"}.`,
      };
    }
    return {
      ok: true,
      message: `Backup created and verified: ${name} (${formatBytes(size)}).`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Fitness age gate (global, admin-only) ----
// The minimum age (whole years) a profile must be to see Training and AI
// Insights surfaces + the Equipment tab. Empty / non-positive clears it
// (gate off). Setting it changes nav/tabs/pages for every profile, so the whole
// app layout is revalidated. See lib/age-gate.ts.

export async function saveMinTrainingAge(formData: FormData) {
  requireAdmin();
  const raw = String(formData.get("min_training_age") ?? "").trim();
  setMinTrainingAge(raw === "" ? null : Number(raw));
  revalidatePath("/", "layout");
  revalidatePath("/settings/server");
}

// ---- Notifications: profile delivery target (profile scope) ----

// The per-profile parts of notifications: whether reminders are on for this
// profile, the chat they're sent to, and the send schedule. The global bot
// credentials are set separately (admin-only, see saveTelegramBotConfig).
export async function saveNotificationPrefs(formData: FormData) {
  const { profile } = requireWriteAccess();
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
  });
  revalidatePath("/settings/profile");
}

export async function sendTestNotification(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { profile } = requireWriteAccess();
  const results = await dispatch(profile.id, {
    title: "Test notification",
    body: "Notifications are working ✅",
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

// ---- Web Push (login scope, issue #17) ----

// A push subscription belongs to THIS browser + login (like a session), not the
// active profile, so these actions are login-scoped and gate on requireSession()
// rather than requireWriteAccess() — even a read-only member may subscribe their
// own browser to reminders for the profiles they can see. They're allowlisted in
// the write-access enforcement test on that basis.

// Ensure the instance VAPID keypair exists (a one-time, idempotent global
// bootstrap like the Telegram webhook secret — generated lazily so there's no
// admin setup step) and return the PUBLIC key the client needs to subscribe. The
// private key never leaves the server.
export async function getPushPublicKey(): Promise<{
  ok: boolean;
  publicKey?: string;
}> {
  requireSession();
  try {
    return { ok: true, publicKey: ensureVapidKeys() };
  } catch (e) {
    log.error("ensureVapidKeys failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false };
  }
}

// Persist (or refresh) this browser's push subscription for the caller's login.
export async function savePushSubscriptionAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const { login } = requireSession();
  const raw = String(formData.get("subscription") ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid subscription." };
  }
  const sub = parsePushSubscription(parsed);
  if (!sub) return { ok: false, error: "Invalid subscription." };
  savePushSubscription(login.id, sub);
  revalidatePath("/settings");
  return { ok: true };
}

// Remove this browser's push subscription (scoped to the caller's login).
export async function deletePushSubscriptionAction(
  formData: FormData
): Promise<{ ok: boolean }> {
  const { login } = requireSession();
  const endpoint = String(formData.get("endpoint") ?? "");
  if (endpoint) deletePushSubscription(login.id, endpoint);
  revalidatePath("/settings");
  return { ok: true };
}

// Send a test push to the caller's own subscribed browsers.
export async function sendTestPush(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { login } = requireSession();
  try {
    const targeted = await sendTestPushToLogin(login.id, {
      title: "Test notification",
      body: "Web push is working ✅",
    });
    if (targeted === 0)
      return {
        ok: false,
        message:
          "No subscribed browsers for your login. Enable push on this browser first.",
      };
    return { ok: true, message: "Sent ✅ — check your notifications." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Notifications: global bot credentials (global, admin-only) ----

// The bot token and inbound transport mode are app-wide (a single bot serves
// every profile), so only an admin may change them.
export async function saveTelegramBotConfig(formData: FormData) {
  requireAdmin();
  const prevMode = getTelegramBotConfig().telegramMode;
  const cfg = setTelegramBotConfig({
    telegramBotToken: String(formData.get("telegram_bot_token") ?? ""),
    telegramMode:
      formData.get("telegram_mode") === "webhook" ? "webhook" : "poll",
  });
  // Switching to polling: drop any registered webhook, since Telegram rejects
  // getUpdates while one is set. Best-effort — the poller reports 409s anyway.
  if (
    prevMode === "webhook" &&
    cfg.telegramMode === "poll" &&
    cfg.telegramBotToken
  ) {
    try {
      await deleteWebhook();
    } catch (e) {
      log.warn("deleteWebhook on mode switch failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  revalidatePath("/settings/server");
}

export async function registerTelegramWebhook(): Promise<{
  ok: boolean;
  message: string;
}> {
  requireAdmin();
  const cfg = getTelegramBotConfig();
  if (!cfg.telegramBotToken)
    return { ok: false, message: "Save your bot token first." };
  if (!cfg.telegramWebhookSecret)
    return {
      ok: false,
      message: "Save settings first to generate a webhook secret.",
    };
  const url = getPublicUrl();
  if (!url)
    return {
      ok: false,
      message: "Set the public app URL (in the card above) first.",
    };
  try {
    await setWebhook(`${url}/api/telegram/webhook`, cfg.telegramWebhookSecret);
    return { ok: true, message: "Webhook registered ✅" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Two-factor authentication (login scope, issue #23) ----
//
// All four actions operate on the CALLER's OWN login (like change-own-password),
// so they gate on requireSession() and are allowlisted in the write-access
// enforcement test on that basis — they touch login-owned auth state, never
// profile-owned data. Enabling requires verifying a code (proving the secret was
// imported); disabling requires the current password AND a valid code, so a
// walk-up attacker with an open session can't strip 2FA off.

// Step 1 of enrollment: mint a pending secret and hand back the otpauth:// URI +
// the manual base32 key. No code is required yet; the secret isn't enforced until
// activate2fa verifies a code. Refuses if 2FA is already active.
export async function begin2fa(): Promise<
  | { ok: true; secret: string; otpauthUrl: string }
  | { ok: false; error: string }
> {
  const { login } = requireSession();
  if (getLoginTotpState(login.id).enabled)
    return { ok: false, error: "Two-factor authentication is already on." };
  const { secret, otpauthUrl } = beginTotpEnrollment(login.id, login.username);
  return { ok: true, secret, otpauthUrl };
}

// Step 2 of enrollment: verify one code against the pending secret, flip 2FA on,
// and return the one-time recovery codes to show ONCE. A wrong code leaves the
// pending secret in place so the user can retry.
export async function activate2fa(
  formData: FormData
): Promise<
  { ok: true; recoveryCodes: string[] } | { ok: false; error: string }
> {
  const { login } = requireSession();
  if (getLoginTotpState(login.id).enabled)
    return { ok: false, error: "Two-factor authentication is already on." };
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { ok: false, error: "Enter the 6-digit code." };
  if (!activateTotp(login.id, code))
    return {
      ok: false,
      error: "That code didn't match. Check the time on your device and retry.",
    };
  const recoveryCodes = regenerateRecoveryCodes(login.id);
  recordAudit({
    loginId: login.id,
    action: AUDIT_ACTIONS.twofaEnable,
    target: String(login.id),
  });
  revalidatePath("/settings");
  return { ok: true, recoveryCodes };
}

// Turn 2FA off. Requires the current password AND a valid TOTP/recovery code so a
// hijacked live session alone can't remove the second factor.
export async function disable2fa(
  formData: FormData
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { login } = requireSession();
  if (!getLoginTotpState(login.id).enabled)
    return { ok: false, error: "Two-factor authentication isn't on." };
  const password = String(formData.get("current_password") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const row = db
    .prepare("SELECT password_hash FROM logins WHERE id = ?")
    .get(login.id) as { password_hash: string } | undefined;
  if (!row) return { ok: false, error: "Login not found." };
  if (!(await verifyPassword(password, row.password_hash)))
    return { ok: false, error: "Current password is incorrect." };
  if (!verifyLoginSecondFactor(login.id, code).ok)
    return { ok: false, error: "That code didn't match." };
  disableTotp(login.id);
  recordAudit({
    loginId: login.id,
    action: AUDIT_ACTIONS.twofaDisable,
    target: String(login.id),
  });
  revalidatePath("/settings");
  return { ok: true, message: "Two-factor authentication turned off." };
}

// Regenerate recovery codes (invalidates the old set). Requires a valid current
// code so only someone holding the authenticator (or a remaining recovery code)
// can rotate them. Returns the fresh codes to show once.
export async function regenerate2faRecoveryCodes(
  formData: FormData
): Promise<
  { ok: true; recoveryCodes: string[] } | { ok: false; error: string }
> {
  const { login } = requireSession();
  if (!getLoginTotpState(login.id).enabled)
    return { ok: false, error: "Two-factor authentication isn't on." };
  const code = String(formData.get("code") ?? "").trim();
  if (!verifyLoginSecondFactor(login.id, code).ok)
    return { ok: false, error: "That code didn't match." };
  const recoveryCodes = regenerateRecoveryCodes(login.id);
  revalidatePath("/settings");
  return { ok: true, recoveryCodes };
}
