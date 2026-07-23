"use server";
// Login-scoped settings actions — the Preferences tab (Settings) plus the
// account-security controls (change-own-password, active sessions, web push, 2FA).
// These operate on the caller's own LOGIN (unit prefs keyed by login.id, session
// teardown, push subscriptions, TOTP), never profile-owned data, so they gate on
// requireSession()/requireLoginWriteAccess() and are allowlisted in the
// write-access enforcement test on that basis.
//
// The admin/global actions (Server tab) and active-profile actions (Profile tab)
// were split out by auth tier (#319) into ./server/actions and ./profile/actions.
// A "use server" file may only export async functions (Next forbids re-exports),
// so those tabs' components import directly from the split modules.
import {
  requireSession,
  requireLoginWriteAccess,
  destroyOtherSessionsForCurrent,
  revokeSession,
  setOwnProfileForLogin,
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
  setDisplayFormatPrefs,
  setLoginPushDisabledKinds,
  getLoginTelegram,
  setLoginTelegram,
  setLoginTelegramDisabledKinds,
  isProfileMutedForLogin,
  setProfileMutedForLogin,
  clearNotifyReviewNeeded,
  getTelegramBotConfig,
  getProfileFoodTelegram,
  getFoodTelegramPrompted,
  setFoodTelegramPrompted,
  getUserAge,
  type DistanceUnit,
  type WeightUnit,
  type TemperatureUnit,
  type TimeFormat,
  type DateFormat,
} from "@/lib/settings";
import {
  ensureVapidKeys,
  savePushSubscription,
  deletePushSubscription,
  sendTestPushToLogin,
} from "@/lib/notifications/push";
import { sendTelegramMessage } from "@/lib/notifications/telegram";
import { sendFoodOptInPrompt } from "@/lib/notifications/food";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { canAccessProfile } from "@/lib/auth";
import { parsePushSubscription } from "@/lib/notifications/push-core";
import { parseDisabledKinds } from "@/lib/notifications/home-assistant-core";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";

const log = createLogger("settings");

// ---- Preferences (login scope) ----

// Unit display preferences belong to the signed-in login, not the active
// profile, so they're keyed by login.id and available to every login.
export async function saveUnitPrefs(formData: FormData) {
  const { login } = await requireSession();
  const weightUnit = (
    formData.get("weight_unit") === "lb" ? "lb" : "kg"
  ) as WeightUnit;
  const distanceUnit = (
    formData.get("distance_unit") === "mi" ? "mi" : "km"
  ) as DistanceUnit;
  const temperatureUnit = (
    formData.get("temperature_unit") === "C" ? "C" : "F"
  ) as TemperatureUnit;
  setUnitPrefs(login.id, { weightUnit, distanceUnit, temperatureUnit });
  // Units affect display across the whole app.
  revalidatePath("/", "layout");
}

// Date/time display preferences (#964) — like unit prefs, keyed by the signed-in
// login and applied at every date/time render boundary. Unknown values fall back to
// the status-quo default (24h; "Mon D, YYYY") server-side, so a hand-crafted post
// can't store a nonsense format.
export async function saveDisplayFormatPrefs(formData: FormData) {
  const { login } = await requireSession();
  const timeFormat = (
    formData.get("time_format") === "12h" ? "12h" : "24h"
  ) as TimeFormat;
  const rawDate = formData.get("date_format");
  const dateFormat = (
    rawDate === "dmy" || rawDate === "iso" ? rawDate : "mdy"
  ) as DateFormat;
  setDisplayFormatPrefs(login.id, { timeFormat, dateFormat });
  // Date/time formatting is applied across the whole app.
  revalidatePath("/", "layout");
}

// ---- Own-profile association (issue #1013) ----

// Point the caller's OWN login at one of its accessible profiles as "mine", or
// clear it (profileId absent/"none" → null). Login-scoped auth state (like
// change-own-password) — it labels which profile is the login's self and grants NO
// access, so it gates on requireLoginWriteAccess (demo-gated: the shared demo login
// must not let one visitor relabel everyone's self). The accessibility constraint
// lives in setOwnProfileForLogin (only an accessible profile may be marked own); a
// forged inaccessible id is a silent no-op there, surfaced as a friendly error.
export async function saveOwnProfile(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const { login } = await requireLoginWriteAccess();
  const raw = formData.get("own_profile_id");
  const profileId =
    raw === null || raw === "" || raw === "none" ? null : Number(raw);
  if (profileId !== null && !Number.isInteger(profileId)) {
    return { ok: false, error: "Invalid profile." };
  }
  const ok = setOwnProfileForLogin(login.id, login.role, profileId);
  if (!ok) {
    return {
      ok: false,
      error: "That profile isn't one you can act as. Reload and try again.",
    };
  }
  // The own-profile link drives the not-self write labels across the whole app.
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---- Change own password ----

// Available to every login (not admin-only): the caller changes their own
// password after proving they know the current one. On success every OTHER
// session for the login is signed out (a password change should evict any
// stale device) while the current session is kept alive.
// requireLoginWriteAccess (#278): in demo mode the shared demo login's password
// is public — letting a visitor rotate it locks everyone else out until the
// nightly reset, so the demo guard refuses it server-side.
export async function changeOwnPassword(
  formData: FormData
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { login } = await requireLoginWriteAccess();
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
  await destroyOtherSessionsForCurrent(login.id);
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
// requireLoginWriteAccess (#278): the demo login is SHARED — "the caller's own
// sessions" are every other visitor's sessions, so demo mode refuses revocation.
export async function revokeSessionAction(formData: FormData) {
  const { login } = await requireLoginWriteAccess();
  const id = String(formData.get("session_id") ?? "");
  if (id) revokeSession(login.id, id);
  revalidatePath("/settings");
}

// "Sign out everywhere else": drop every session for this login except the one
// making the request. Standalone counterpart to the eviction that a password
// change triggers. Demo-guarded like revokeSessionAction (#278).
export async function signOutOtherSessions() {
  const { login } = await requireLoginWriteAccess();
  await destroyOtherSessionsForCurrent(login.id);
  revalidatePath("/settings");
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
  await requireSession();
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
  const { login } = await requireSession();
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
  const { login } = await requireSession();
  const endpoint = String(formData.get("endpoint") ?? "");
  if (endpoint) deletePushSubscription(login.id, endpoint);
  revalidatePath("/settings");
  return { ok: true };
}

// The push column of the notification matrix (#928) — LOGIN-scoped, like the push
// subscription itself. Persists the caller's disabled-kinds set (JSON `disabled_kinds`
// field, validated by the shared pure core). Login-scoped, so it gates on
// requireSession() like the other push actions and is allowlisted in the write-access
// enforcement test on that basis — it touches login-owned settings, never
// profile-owned data. A message whose kind a login turned off skips that login's
// browsers at the push send seam.
export async function savePushNotifyKinds(
  formData: FormData
): Promise<{ ok: boolean }> {
  const { login } = await requireSession();
  const disabled = parseDisabledKinds(
    String(formData.get("disabled_kinds") ?? "")
  );
  setLoginPushDisabledKinds(login.id, disabled);
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// Send a test push to the caller's own subscribed browsers.
export async function sendTestPush(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { login } = await requireSession();
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

// ---- Telegram delivery channel (login scope, issue #1072) ----
//
// The Telegram chat belongs to the LOGIN (a person with a phone), not the profile
// (a data subject) — a per-profile notification fans out to the logins that manage
// it (lib/notifications/fan-out.ts). So the channel enable + chat id, the per-kind
// Telegram matrix column, and the "mute this profile" override are all login-scoped
// and gate on requireSession() like the push actions, never requireWriteAccess on a
// profile. Allowlisted in actions-write-access.test.ts on that basis.

export async function saveLoginTelegram(formData: FormData): Promise<{
  ok: boolean;
}> {
  const { login, profile } = await requireSession();

  // Whether the acting profile was reachable over the login's Telegram BEFORE this
  // save, so we can offer the one-time food-logging opt-in on first connection
  // (#682) — now keyed on the LOGIN's channel becoming live.
  const botConfigured = getTelegramBotConfig().telegramBotToken !== "";
  const before = getLoginTelegram(login.id);
  const wasReachable =
    botConfigured &&
    before.telegramEnabled &&
    before.telegramChatId !== "" &&
    !isProfileMutedForLogin(login.id, profile.id);

  const enabledRaw = formData.get("telegram_enabled");
  setLoginTelegram(login.id, {
    telegramEnabled: enabledRaw === "on" || enabledRaw === "1",
    telegramChatId: String(formData.get("telegram_chat_id") ?? ""),
  });
  // Saving the channel is the login confirming its notification settings, so clear
  // any post-migration "review your settings" flag (#1072).
  clearNotifyReviewNeeded(login.id);

  const after = getLoginTelegram(login.id);
  const nowReachable =
    botConfigured &&
    after.telegramEnabled &&
    after.telegramChatId !== "" &&
    !isProfileMutedForLogin(login.id, profile.id);
  if (
    nowReachable &&
    !wasReachable &&
    getProfileFoodTelegram(profile.id) === false &&
    !getFoodTelegramPrompted(profile.id) &&
    isFoodLoggingRelevant(getUserAge(profile.id))
  ) {
    setFoodTelegramPrompted(profile.id);
    try {
      await sendFoodOptInPrompt(profile.id);
    } catch {
      // A failed prompt send is non-critical — the toggle still lives in Settings.
    }
  }
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// The per-kind Telegram matrix column, now login-scoped (#1072).
export async function saveLoginTelegramNotifyKinds(
  formData: FormData
): Promise<{ ok: boolean }> {
  const { login } = await requireSession();
  const disabled = parseDisabledKinds(
    String(formData.get("disabled_kinds") ?? "")
  );
  setLoginTelegramDisabledKinds(login.id, disabled);
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// Mute (or un-mute) a specific profile for the CALLER's login (#1072): "don't
// notify me about Grandpa". Login-scoped; only affects THIS login's fan-out, never
// the other logins that manage the same profile. Safety-tier mute is allowed but
// off by default. The profile must be one the caller can access (a forged id is
// rejected) so a login can't create mute state for a profile outside its scope.
export async function saveProfileNotifyMute(
  formData: FormData
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const profileId = Number(formData.get("profile_id"));
  if (!Number.isInteger(profileId) || !canAccessProfile(session, profileId))
    return { ok: false };
  const muted = formData.get("muted") === "on" || formData.get("muted") === "1";
  setProfileMutedForLogin(session.login.id, profileId, muted);
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// Send a test message to the caller's OWN Telegram chat (login-scoped, #1072),
// bypassing the profile fan-out so a login can always verify its own channel.
export async function sendTestNotification(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { login } = await requireSession();
  const { telegramBotToken } = getTelegramBotConfig();
  const { telegramEnabled, telegramChatId } = getLoginTelegram(login.id);
  if (!telegramBotToken || !telegramEnabled || !telegramChatId)
    return {
      ok: false,
      message:
        "No Telegram channel — enable Telegram, fill in your chat id, and ask an admin to set the bot token on Settings → Server.",
    };
  try {
    await sendTelegramMessage(telegramChatId, {
      title: "Test notification",
      body: "Notifications are working ✅",
      kind: "test",
    });
    return { ok: true, message: "Sent ✅ — check your Telegram." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Two-factor authentication (login scope, issue #23) ----
//
// All four actions operate on the CALLER's OWN login (like change-own-password),
// so they gate on the login scope (not requireWriteAccess) and are allowlisted in
// the write-access enforcement test on that basis — they touch login-owned auth
// state, never profile-owned data. Enabling requires verifying a code (proving
// the secret was imported); disabling requires the current password AND a valid
// code, so a walk-up attacker with an open session can't strip 2FA off.
// Enrollment (begin/activate) gates on requireLoginWriteAccess (#278): a demo
// visitor enrolling 2FA on the shared demo login would lock every other visitor
// out. disable2fa/regenerate2faRecoveryCodes stay on requireSession() — both
// require 2FA to already be ON plus a valid code (+ password for disable), which
// the demo login can never reach once enrollment is refused, and blocking
// disable would forbid the remediation, not the attack.

// Step 1 of enrollment: mint a pending secret and hand back the otpauth:// URI +
// the manual base32 key. No code is required yet; the secret isn't enforced until
// activate2fa verifies a code. Refuses if 2FA is already active.
export async function begin2fa(): Promise<
  | { ok: true; secret: string; otpauthUrl: string }
  | { ok: false; error: string }
> {
  const { login } = await requireLoginWriteAccess();
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
  const { login } = await requireLoginWriteAccess();
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
  const { login } = await requireSession();
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
  const { login } = await requireSession();
  if (!getLoginTotpState(login.id).enabled)
    return { ok: false, error: "Two-factor authentication isn't on." };
  const code = String(formData.get("code") ?? "").trim();
  if (!verifyLoginSecondFactor(login.id, code).ok)
    return { ok: false, error: "That code didn't match." };
  const recoveryCodes = regenerateRecoveryCodes(login.id);
  revalidatePath("/settings");
  return { ok: true, recoveryCodes };
}
