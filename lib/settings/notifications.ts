import crypto from "node:crypto";
import { db, writeTx } from "../db";
import type { NotificationKind } from "../notifications/types";
import {
  parseDisabledKinds,
  serializeDisabledKinds,
} from "../notifications/home-assistant-core";
import {
  parseFoodNudgePointer,
  serializeFoodNudgePointer,
  type FoodNudgePointer,
} from "../notifications/food-nudge-pointer";
import {
  getSetting,
  setSetting,
  getProfileSetting,
  setProfileSetting,
  getLoginSetting,
  setLoginSetting,
} from "./kv";
import {
  DEFAULT_INTAKE_REMINDER_HOURS,
  WAKING_START_HOUR,
  WAKING_END_HOUR,
  AUTO_HOUR,
  parseNotifyHour,
} from "../notifications/schedule";
import { typicalWakeTime } from "../queries/sleep";

// How inbound Telegram button taps reach the app: "poll" long-polls getUpdates
// (works without a public URL), "webhook" has Telegram POST to /api/telegram/webhook.
// Mutually exclusive on Telegram's side — getUpdates 409s while a webhook is set.
export type TelegramMode = "poll" | "webhook";

// Global Telegram bot credentials (the bot token, inbound-webhook secret, and
// transport mode are app-wide — a single bot serves every profile).
export interface TelegramBotConfig {
  telegramBotToken: string;
  telegramMode: TelegramMode;
  // Authenticates inbound webhook calls from Telegram (sent as the
  // x-telegram-bot-api-secret-token header). Auto-generated on first save.
  telegramWebhookSecret: string;
}

export function getTelegramBotConfig(): TelegramBotConfig {
  return {
    telegramBotToken: getSetting("telegram_bot_token") ?? "",
    telegramMode:
      getSetting("telegram_mode") === "webhook" ? "webhook" : "poll",
    telegramWebhookSecret: getSetting("telegram_webhook_secret") ?? "",
  };
}

// Per-profile Telegram delivery target (whether reminders are on for this profile
// and the chat they're sent to).
export interface ProfileTelegram {
  telegramEnabled: boolean;
  telegramChatId: string;
}

export function getProfileTelegram(profileId: number): ProfileTelegram {
  return {
    telegramEnabled: getProfileSetting(profileId, "telegram_enabled") === "1",
    telegramChatId: getProfileSetting(profileId, "telegram_chat_id") ?? "",
  };
}

// ---- Food logging over Telegram (issue #682) — per-profile opt-in ----
// Whether this profile gets the morning/midday/evening food-log nudge with one-tap
// serving buttons. OFF by default (opt-in): a `food_telegram_enabled` "1"/"0" flag
// in profile_settings, mirroring the telegram_enabled shape. `food_telegram_prompted`
// records that we've already asked once (on first Telegram connection) so the prompt
// never re-nags. Both are plain KV markers; the food nudge + button handler gate on
// the enabled flag, the connection prompt on the prompted marker.

export function getProfileFoodTelegram(profileId: number): boolean {
  return getProfileSetting(profileId, "food_telegram_enabled") === "1";
}

export function setProfileFoodTelegram(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "food_telegram_enabled", enabled ? "1" : "0");
}

// ---- Daily mood check-in (issue #992) — per-profile opt-in, off by default ----
// Whether this profile gets the gentle once-daily wellbeing check-in
// (Telegram/push). A `mood_checkin_enabled` "1"/"0" flag in profile_settings,
// mirroring food_telegram_enabled. The companion `mood_checkin_ignored` counter is
// the engagement-aware auto-pause state: bumped on each sent-but-unanswered
// check-in, RESET by every submitted check-in (any write path), and consulted by
// the pure shouldSendMoodCheckin gate (lib/mood.ts) — at
// MOOD_CHECKIN_AUTOPAUSE_DAYS the reminder holds silently until a submission
// re-arms it. Never an escalation: pausing is the only behavior.

export function getProfileMoodCheckin(profileId: number): boolean {
  return getProfileSetting(profileId, "mood_checkin_enabled") === "1";
}

export function setProfileMoodCheckin(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "mood_checkin_enabled", enabled ? "1" : "0");
}

export function getMoodCheckinIgnored(profileId: number): number {
  const n = Number(getProfileSetting(profileId, "mood_checkin_ignored"));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function bumpMoodCheckinIgnored(profileId: number): void {
  setProfileSetting(
    profileId,
    "mood_checkin_ignored",
    String(getMoodCheckinIgnored(profileId) + 1)
  );
}

export function resetMoodCheckinIgnored(profileId: number): void {
  setProfileSetting(profileId, "mood_checkin_ignored", "0");
}

// Whether the weekly recap includes the gentle mood line (issue #992) — a summary
// (average + days logged), never a score to beat. Per-profile opt-in, off by
// default, read by the ONE gatherRecapInput both the widget and the notification
// share.
export function getProfileMoodRecap(profileId: number): boolean {
  return getProfileSetting(profileId, "mood_recap_enabled") === "1";
}

export function setProfileMoodRecap(profileId: number, enabled: boolean): void {
  setProfileSetting(profileId, "mood_recap_enabled", enabled ? "1" : "0");
}

// ---- Morning-digest sleep summary (issue #1117) — per-profile opt-in ----
// Whether the morning digest includes a calm "how'd I sleep" section (last night's
// MAIN overnight session vs baseline, stage breakdown, an SRI note, any nap on its
// own line). OFF by default (opt-in, the #992 non-judgmental posture), so an
// existing digest never sprouts a sleep line unasked. A `digest_sleep_enabled`
// "1"/"0" flag in profile_settings, mirroring mood_checkin_enabled. The section
// still collapses when there's no fresh sleep data even when enabled.
export function getProfileSleepDigest(profileId: number): boolean {
  return getProfileSetting(profileId, "digest_sleep_enabled") === "1";
}

export function setProfileSleepDigest(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "digest_sleep_enabled", enabled ? "1" : "0");
}

export function getFoodTelegramPrompted(profileId: number): boolean {
  return getProfileSetting(profileId, "food_telegram_prompted") === "1";
}

export function setFoodTelegramPrompted(profileId: number): void {
  setProfileSetting(profileId, "food_telegram_prompted", "1");
}

// The pointer to the LAST food nudge this profile was sent over Telegram (#947), so
// the NEXT send can close that message's stale keyboard. One pointer per profile,
// overwritten on every send — id-keyed, no cleanup class (#203): profile deletion
// wipes the profile_settings row and ids never recycle. A malformed/absent value
// parses to null (the send just skips the previous-strip that tick).
export function getFoodNudgePointer(
  profileId: number
): FoodNudgePointer | null {
  return parseFoodNudgePointer(
    getProfileSetting(profileId, "food_nudge_last_message")
  );
}

export function setFoodNudgePointer(
  profileId: number,
  pointer: FoodNudgePointer
): void {
  setProfileSetting(
    profileId,
    "food_nudge_last_message",
    serializeFoodNudgePointer(pointer)
  );
}

// Resolve every profile a Telegram chat id belongs to. A single chat (e.g. a
// family group) can be the delivery target for several profiles, so this returns
// all of them — inbound button taps carry only a chat id, and the callback
// handler picks the one the button token names (rejecting taps from an unknown
// chat). The chat id is stored as a string in profile_settings; callers stringify.
export function getProfilesByTelegramChatId(chatId: string): number[] {
  if (!chatId) return [];
  const rows = db
    .prepare(
      "SELECT profile_id FROM profile_settings WHERE key = 'telegram_chat_id' AND value = ?"
    )
    .all(chatId) as { profile_id: number }[];
  return rows.map((r) => r.profile_id);
}

// Merged view (global bot config + this profile's delivery target), for the
// settings page and outbound notifications.
export interface NotificationConfig
  extends TelegramBotConfig, ProfileTelegram {}

export function getNotificationConfig(profileId: number): NotificationConfig {
  return { ...getTelegramBotConfig(), ...getProfileTelegram(profileId) };
}

// Persist this profile's Telegram delivery target (enable toggle + chat id).
// Per-profile, so any login acting as the profile may set it (member-safe).
export function setProfileTelegram(
  profileId: number,
  cfg: { telegramEnabled: boolean; telegramChatId: string }
): ProfileTelegram {
  setProfileSetting(
    profileId,
    "telegram_enabled",
    cfg.telegramEnabled ? "1" : "0"
  );
  setProfileSetting(profileId, "telegram_chat_id", cfg.telegramChatId.trim());
  return getProfileTelegram(profileId);
}

// ---- Home Assistant notification channel (per profile, issue #248) ----
// A per-profile outbound webhook so Home Assistant can present reminders with what
// only IT knows — who is home, which room — as kitchen-speaker TTS, escalation
// light-flashes, presence-aware delivery. Mirrors the Telegram split: this is the
// per-profile delivery TARGET (enable + webhook URL + optional shared secret + which
// kinds to forward). There is no global HA config — every household points at its own
// HA instance per profile. Stored as discrete profile_settings keys:
//   ha_notify_enabled        "1" | "0"
//   ha_notify_webhook_url     the HA webhook URL (http(s)://host:8123/api/webhook/<id>)
//   ha_notify_secret          optional shared secret echoed as the X-Allos-Webhook-Secret header
//   ha_notify_disabled_kinds  JSON string[] of NotificationKind held OUT of this channel

export interface ProfileHomeAssistant {
  enabled: boolean;
  webhookUrl: string;
  secret: string;
  disabledKinds: NotificationKind[]; // kinds NOT forwarded (absence = all forwarded)
}

export function getProfileHomeAssistant(
  profileId: number
): ProfileHomeAssistant {
  return {
    enabled: getProfileSetting(profileId, "ha_notify_enabled") === "1",
    webhookUrl: getProfileSetting(profileId, "ha_notify_webhook_url") ?? "",
    secret: getProfileSetting(profileId, "ha_notify_secret") ?? "",
    disabledKinds: parseDisabledKinds(
      getProfileSetting(profileId, "ha_notify_disabled_kinds")
    ),
  };
}

// Persist this profile's HA delivery target. Per-profile, so any login with write
// access to the profile may set it (member-safe). The URL/secret are trimmed; the
// disabled-kinds set is validated + serialized by the pure core.
export function setProfileHomeAssistant(
  profileId: number,
  cfg: {
    enabled: boolean;
    webhookUrl: string;
    secret: string;
    disabledKinds: readonly NotificationKind[];
  }
): ProfileHomeAssistant {
  writeTx(() => {
    setProfileSetting(profileId, "ha_notify_enabled", cfg.enabled ? "1" : "0");
    setProfileSetting(
      profileId,
      "ha_notify_webhook_url",
      cfg.webhookUrl.trim()
    );
    setProfileSetting(profileId, "ha_notify_secret", cfg.secret.trim());
    setProfileSetting(
      profileId,
      "ha_notify_disabled_kinds",
      serializeDisabledKinds(cfg.disabledKinds)
    );
  });
  return getProfileHomeAssistant(profileId);
}

// ---- Per-channel per-kind delivery matrix (#928) ----
// The notification matrix (Settings → Notifications) answers "which messages reach
// me where" as one grid, rows = kinds × columns = channels. Each column persists in
// ITS channel's tier store — so the matrix is one UI over three tier-correct
// settings, saved through tier-correct actions (#319). HA already had
// `ha_notify_disabled_kinds` (profile); #928 adds the Telegram (profile) and push
// (login) columns. All three are plain KV JSON arrays of DISABLED kinds (absence =
// every kind on), parsed/serialized by the shared pure core. No schema change.

// Telegram column — per PROFILE (a chat id belongs to one tracked person), beside
// the profile's telegram_enabled / chat id.
export function getProfileTelegramDisabledKinds(
  profileId: number
): NotificationKind[] {
  return parseDisabledKinds(
    getProfileSetting(profileId, "telegram_notify_disabled_kinds")
  );
}

export function setProfileTelegramDisabledKinds(
  profileId: number,
  kinds: readonly NotificationKind[]
): void {
  setProfileSetting(
    profileId,
    "telegram_notify_disabled_kinds",
    serializeDisabledKinds(kinds)
  );
}

// Push column — per LOGIN (a browser subscription belongs to a login, not a
// profile — mirrors where the subscription itself lives). A push message for a
// profile fans out to every entitled login's browsers; each login's disabled set
// gates its own subscriptions at the send seam.
export function getLoginPushDisabledKinds(loginId: number): NotificationKind[] {
  return parseDisabledKinds(
    getLoginSetting(loginId, "push_notify_disabled_kinds")
  );
}

export function setLoginPushDisabledKinds(
  loginId: number,
  kinds: readonly NotificationKind[]
): void {
  setLoginSetting(
    loginId,
    "push_notify_disabled_kinds",
    serializeDisabledKinds(kinds)
  );
}

// Persist the global bot credentials (token + inbound transport mode). App-wide,
// so this is an admin-only operation — a single bot serves every profile.
export function setTelegramBotConfig(cfg: {
  telegramBotToken: string;
  telegramMode: TelegramMode;
}): TelegramBotConfig {
  // Write the token, mode, and one-time webhook secret as one transaction (mirrors
  // setUnitPrefs) so a partial failure can't leave the config half-updated.
  writeTx(() => {
    setSetting("telegram_bot_token", cfg.telegramBotToken.trim());
    setSetting("telegram_mode", cfg.telegramMode);
    // Generate a stable webhook secret once, so inbound calls can be authenticated.
    if (!getSetting("telegram_webhook_secret")) {
      setSetting("telegram_webhook_secret", crypto.randomUUID());
    }
  });
  return getTelegramBotConfig();
}

// When each notification slot is sent. Supplement windows have a fixed hour
// (0-23, interpreted in the profile's own timezone — see getTimezone, which the
// scheduler resolves against, not the container's local time) or null = off; the
// workout reminder's timing is derived from the user's history (see
// inferWorkoutSchedule), so it's just on/off here.
export interface NotifySchedule {
  supplementHours: {
    Morning: number | null;
    Midday: number | null;
    Evening: number | null;
    Bedtime: number | null;
  };
  workoutEnabled: boolean;
  // Whether the Morning intake slot follows the profile's wake time (issue #1117).
  // When true, `supplementHours.Morning` above already holds the RESOLVED wake hour
  // (typicalWakeTime, or the hardcoded default when there's no sleep data yet); this
  // flag is what the settings form and the write path key on to persist the "auto"
  // sentinel instead of round-tripping the resolved number as a manual choice. A
  // manual hour or "off" leaves this false.
  morningAuto: boolean;
  // Morning digest: the hour (0-23, this profile's timezone) to send
  // the once-a-day summary, or null = off. Off by default. When `digestAuto` is
  // true this holds the resolved wake hour and the digest is ON at that hour.
  digestHour: number | null;
  // Whether the morning digest follows the wake time (issue #1117). Unlike the
  // Morning slot, an ABSENT digest stays off (opt-in) — only an explicit "auto"
  // turns it on at the wake hour, so this is true solely for the stored sentinel.
  digestAuto: boolean;
  // Weekly recap (issue #32): the weekday (0=Sun … 6=Sat, this profile's timezone)
  // to send the seven-day summary, or null = off. Off by default. The recap fires
  // at weeklyRecapHour on that weekday.
  weeklyRecapDay: number | null;
  weeklyRecapHour: number | null; // hour 0-23; defaults to 9 when a day is set
  // Milestone alerts (issue #32): whether to notify when a milestone fires. On by
  // default — milestones are always recorded to the timeline regardless; this only
  // gates the (quiet) push/Telegram alert.
  milestonesEnabled: boolean;
  // Preventive-care reminders (issue #87): whether due/overdue preventive visits &
  // screenings send a proactive nudge AND appear in the "what's due" digest. On by
  // default. Off suppresses both push paths; the Upcoming page still lists them
  // (that's a pull surface, not a push).
  preventiveEnabled: boolean;
  // Quiet hours (issue #450): the profile-local WAKING window (inclusive hours 0-23)
  // during which the non-time-critical EPISODE nudges (refill, preventive, milestone)
  // may be sent; outside it they're held to the next in-window tick. Defaults to the
  // #378 constant (8→21). A window that wraps past midnight (start > end) is supported
  // for night-shift rhythms (see inWakingWindow). SAFETY-tier sends (dose reminders,
  // missed-dose escalation) NEVER consult this — the slot-anchored senders (digest,
  // workout, recap) are user-timed and also unaffected.
  wakingStartHour: number;
  wakingEndHour: number;
}

const SUPP_HOUR_KEYS = {
  Morning: "notify_supp_morning_hour",
  Midday: "notify_supp_midday_hour",
  Evening: "notify_supp_evening_hour",
  Bedtime: "notify_supp_bedtime_hour",
} as const;
// Convert a typical-wake clock MINUTE (0..1439) to the notify HOUR (0-23),
// rounding to the nearest hour so a 6:50 wake seeds 7:00, not 6:00. Clamped so a
// late-evening median can't wrap to hour 0. Null minute → null (no sleep data).
function wakeMinuteToHour(min: number | null): number | null {
  if (min == null) return null;
  return Math.min(23, Math.round(min / 60));
}

export function getNotifySchedule(profileId: number): NotifySchedule {
  const morningRaw = getProfileSetting(profileId, SUPP_HOUR_KEYS.Morning);
  const digestRaw = getProfileSetting(profileId, "notify_digest_hour");

  // The wake-derived Morning hour (issue #1117), computed only when a slot actually
  // needs it — an absent/auto Morning, or an "auto" digest. A profile with an
  // explicit manual Morning hour and a non-auto digest never pays the sleep read.
  const needsWake =
    morningRaw === undefined ||
    morningRaw === AUTO_HOUR ||
    digestRaw === AUTO_HOUR;
  const wakeHour = needsWake
    ? wakeMinuteToHour(typicalWakeTime(profileId))
    : null;
  // Auto/absent Morning resolves to the wake hour, or the hardcoded default when no
  // sleep data yet — graceful degradation.
  const morningAutoValue = wakeHour ?? DEFAULT_INTAKE_REMINDER_HOURS.Morning;

  return {
    supplementHours: {
      // Morning: absent OR "auto" → wake-derived; "N" → manual (wins); "" → off.
      Morning: parseNotifyHour(morningRaw, morningAutoValue, morningAutoValue),
      Midday: parseNotifyHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Midday),
        DEFAULT_INTAKE_REMINDER_HOURS.Midday
      ),
      Evening: parseNotifyHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Evening),
        DEFAULT_INTAKE_REMINDER_HOURS.Evening
      ),
      Bedtime: parseNotifyHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Bedtime),
        DEFAULT_INTAKE_REMINDER_HOURS.Bedtime
      ),
    },
    // The Morning slot is in auto mode when the stored value is the sentinel OR
    // absent (never configured) — both resolve to the wake hour. A manual "N" or an
    // explicit "" (off) is not auto.
    morningAuto: morningRaw === undefined || morningRaw === AUTO_HOUR,
    workoutEnabled:
      (getProfileSetting(profileId, "notify_workout_enabled") ?? "1") === "1",
    // Digest is opt-in: absent → off (null). Only an explicit "auto" turns it on at
    // the wake hour; "N" → manual.
    digestHour: parseNotifyHour(digestRaw, null, morningAutoValue),
    digestAuto: digestRaw === AUTO_HOUR,
    // Weekly recap — off by default (opt-in). Weekday 0-6, else null.
    weeklyRecapDay: parseWeekday(
      getProfileSetting(profileId, "notify_recap_day")
    ),
    weeklyRecapHour:
      parseNotifyHour(getProfileSetting(profileId, "notify_recap_hour"), 9) ??
      9,
    // Milestone alerts on unless explicitly disabled.
    milestonesEnabled:
      (getProfileSetting(profileId, "notify_milestones") ?? "1") === "1",
    // Preventive-care reminders on unless explicitly disabled.
    preventiveEnabled:
      (getProfileSetting(profileId, "notify_preventive") ?? "1") === "1",
    // Quiet hours (#450): waking-window bounds, defaulting to the #378 constant when
    // unset/invalid. parseNotifyHour clamps to 0-23; anything else falls back.
    wakingStartHour:
      parseNotifyHour(
        getProfileSetting(profileId, "notify_waking_start"),
        WAKING_START_HOUR
      ) ?? WAKING_START_HOUR,
    wakingEndHour:
      parseNotifyHour(
        getProfileSetting(profileId, "notify_waking_end"),
        WAKING_END_HOUR
      ) ?? WAKING_END_HOUR,
  };
}

// Parse a stored weekday (0=Sun … 6=Sat); "" / unset / out-of-range → null (off).
function parseWeekday(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

export function setNotifySchedule(
  profileId: number,
  sched: NotifySchedule
): void {
  for (const k of ["Morning", "Midday", "Evening", "Bedtime"] as const) {
    const h = sched.supplementHours[k];
    // The Morning slot persists the "auto" sentinel when it's following the wake
    // time (issue #1117), so re-saving an unchanged form NEVER freezes the resolved
    // wake hour into a manual choice — the blind-write pollution the read-resolution
    // depends on avoiding. All other slots (and Morning when manual/off) write a
    // number or "" as before. Auto wins over the resolved number carried alongside.
    const value =
      k === "Morning" && sched.morningAuto
        ? AUTO_HOUR
        : h == null
          ? ""
          : String(h);
    setProfileSetting(profileId, SUPP_HOUR_KEYS[k], value);
  }
  setProfileSetting(
    profileId,
    "notify_workout_enabled",
    sched.workoutEnabled ? "1" : "0"
  );
  // Digest: "auto" sentinel when following the wake time, else the hour or "" (off).
  setProfileSetting(
    profileId,
    "notify_digest_hour",
    sched.digestAuto
      ? AUTO_HOUR
      : sched.digestHour == null
        ? ""
        : String(sched.digestHour)
  );
  setProfileSetting(
    profileId,
    "notify_recap_day",
    sched.weeklyRecapDay == null ? "" : String(sched.weeklyRecapDay)
  );
  setProfileSetting(
    profileId,
    "notify_recap_hour",
    sched.weeklyRecapHour == null ? "9" : String(sched.weeklyRecapHour)
  );
  setProfileSetting(
    profileId,
    "notify_milestones",
    sched.milestonesEnabled ? "1" : "0"
  );
  setProfileSetting(
    profileId,
    "notify_preventive",
    sched.preventiveEnabled ? "1" : "0"
  );
  // Quiet hours (#450): persist the waking-window bounds as plain 0-23 hours.
  setProfileSetting(
    profileId,
    "notify_waking_start",
    String(sched.wakingStartHour)
  );
  setProfileSetting(
    profileId,
    "notify_waking_end",
    String(sched.wakingEndHour)
  );
}
