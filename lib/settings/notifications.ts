import crypto from "node:crypto";
import { db, writeTx } from "../db";
import type { NotificationKind } from "../notifications/types";
import {
  managingLoginIdsForProfile,
  profilesManagedByLogin,
} from "../notifications/managing-logins";
import {
  intersectDigestDemotions,
  parseDigestDemotions,
  serializeDigestDemotions,
  toggleDigestDemotion,
  type DigestCategory,
} from "../notifications/digest-tune";
import {
  parseDisabledKinds,
  serializeDisabledKinds,
} from "../notifications/home-assistant-core";
import {
  parseHouseholdRoundMembers,
  serializeHouseholdRoundMembers,
} from "../notifications/household-round-format";
import {
  parseFoodNudgePointer,
  serializeFoodNudgePointer,
  type FoodNudgePointer,
} from "../notifications/food-nudge-pointer";
import { parseRecapScale, type RecapScale } from "../recap-scale";
import {
  parseHouseholdRoundPointer,
  serializeHouseholdRoundPointer,
  type HouseholdRoundPointer,
} from "../notifications/household-round-pointer";
import {
  getSetting,
  setSetting,
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
  getLoginSetting,
  setLoginSetting,
} from "./kv";
import {
  DEFAULT_INTAKE_REMINDER_MINUTES,
  WAKING_START_HOUR,
  WAKING_END_HOUR,
  AUTO_TIME,
  formatNotifyTime,
  parseNotifyHour,
  parseNotifyTime,
} from "../notifications/schedule";
import {
  DIGEST_DEFAULT_MINUTE,
  parseDigestMode,
  type DigestMode,
} from "../notifications/digest-schedule";
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

// Login-scoped Telegram delivery channel (issue #1072). The channel belongs to the
// LOGIN (a person with a phone), not the profile (a data subject) — a per-profile
// notification fans out to the logins that manage that profile (see
// lib/notifications/fan-out.ts). `telegramEnabled` is the login's channel switch;
// `telegramChatId` is the chat their reminders land in. Both live in login_settings.
export interface LoginTelegram {
  telegramEnabled: boolean;
  telegramChatId: string;
}

export function getLoginTelegram(loginId: number): LoginTelegram {
  return {
    telegramEnabled: getLoginSetting(loginId, "telegram_enabled") === "1",
    telegramChatId: getLoginSetting(loginId, "telegram_chat_id") ?? "",
  };
}

// Persist this login's Telegram channel (enable toggle + chat id). Login-scoped, so
// any live session for the login may set it via the Preferences (login) tier.
export function setLoginTelegram(
  loginId: number,
  cfg: { telegramEnabled: boolean; telegramChatId: string }
): LoginTelegram {
  writeTx(() => {
    setLoginSetting(
      loginId,
      "telegram_enabled",
      cfg.telegramEnabled ? "1" : "0"
    );
    setLoginSetting(loginId, "telegram_chat_id", cfg.telegramChatId.trim());
  });
  return getLoginTelegram(loginId);
}

// ---- Login-scoped email delivery channel (issue #1855) ----
// Email is the FOURTH delivery channel, and like Telegram/push it belongs to the
// LOGIN (a person with an inbox), not the profile: a per-profile event fans out to
// the managing logins (lib/notifications/email.ts). The ADDRESS is not stored here
// — it is `logins.email` (migration 064), the same address auth mail uses, so
// "where do this person's emails go" has exactly one answer. What lives in
// login_settings is the channel choice:
//   email_notify_enabled       "1" | "0" — OFF by default (a new contact channel is
//                              opt-in; the system may never increase contact
//                              unilaterally)
//   email_notify_full_content  "1" | "0" — the #1855 PHI ruling: absent/other reads
//                              CONTENT-FREE, and ONLY the login's own tap on the
//                              Settings control ever writes "1". No code path may
//                              default, migrate, or infer this to full.
export interface LoginEmailNotify {
  emailEnabled: boolean;
  emailFullContent: boolean;
}

export function getLoginEmailNotify(loginId: number): LoginEmailNotify {
  return {
    emailEnabled: getLoginSetting(loginId, "email_notify_enabled") === "1",
    emailFullContent:
      getLoginSetting(loginId, "email_notify_full_content") === "1",
  };
}

export function setLoginEmailNotify(
  loginId: number,
  cfg: LoginEmailNotify
): LoginEmailNotify {
  writeTx(() => {
    setLoginSetting(
      loginId,
      "email_notify_enabled",
      cfg.emailEnabled ? "1" : "0"
    );
    setLoginSetting(
      loginId,
      "email_notify_full_content",
      cfg.emailFullContent ? "1" : "0"
    );
  });
  return getLoginEmailNotify(loginId);
}

// ---- Per-(login, profile) notification mute (issue #1072) ----
// The per-profile routing flexibility the old per-profile model had, re-homed on the
// login×profile pair: a login can silence a specific profile ("don't notify me about
// Grandpa") without affecting the OTHER logins that manage the same profile. Stored
// as a login_settings marker keyed by the profile id (`notify_mute_profile_<id>`) —
// login-scoped KV, so no schema change and no owned-table ripple; a leftover marker
// after a profile delete is a dead id-keyed key (ids never recycle, #203-safe).
// SAFETY-tier mute is ALLOWED but OFF by default — a co-parent must not silently miss
// a dose escalation; the toggle exists, the default is unmuted.
function muteKey(profileId: number): string {
  return `notify_mute_profile_${profileId}`;
}

export function isProfileMutedForLogin(
  loginId: number,
  profileId: number
): boolean {
  return getLoginSetting(loginId, muteKey(profileId)) === "1";
}

export function setProfileMutedForLogin(
  loginId: number,
  profileId: number,
  muted: boolean
): void {
  setLoginSetting(loginId, muteKey(profileId), muted ? "1" : "0");
}

// ---- Household dose round subscription (issue #1459) ----
// The caregiver-subscribed cross-profile dose reminder. The setting lives on the
// RECEIVING profile (the caregiver's own profile, #1013) because that is the subject
// the round is delivered for — the fan-out then reaches it through the ordinary
// managing-login channels, no special routing. Two profile-scoped keys, no schema
// change: an enable flag and the explicit member selection.
//
// The stored member list is DATA, NOT AN AUTH CHECK (the ProfileScope stance): it
// records what the caregiver ticked. Every read re-validates each id against live
// grants (lib/notifications/household-round-access.ts) at send time AND at button-tap
// time, so a revoked grant drops the member without anyone editing this list.
export interface HouseholdRoundSettings {
  enabled: boolean;
  memberIds: number[];
}

export function getProfileHouseholdRound(
  profileId: number
): HouseholdRoundSettings {
  return {
    enabled: getProfileSetting(profileId, "household_round_enabled") === "1",
    memberIds: parseHouseholdRoundMembers(
      getProfileSetting(profileId, "household_round_members")
    ),
  };
}

export function setProfileHouseholdRound(
  profileId: number,
  cfg: HouseholdRoundSettings
): HouseholdRoundSettings {
  writeTx(() => {
    setProfileSetting(
      profileId,
      "household_round_enabled",
      cfg.enabled ? "1" : "0"
    );
    setProfileSetting(
      profileId,
      "household_round_members",
      serializeHouseholdRoundMembers(cfg.memberIds)
    );
  });
  return getProfileHouseholdRound(profileId);
}

// ---- Post-migration "review your notification settings" flag (issue #1072) ----
// The channel migration (profile → login) is best-effort: a wrong channel is a
// missed notification (recoverable by reconfiguring), never data loss. When the
// per-login channel derivation was AMBIGUOUS (a granted profile's chat differed
// from the login's derived one, or a chat spanned multiple logins), migration 105
// sets this flag (via its own inlined SQL — a shipped migration never calls lib/)
// so the login is nudged to confirm its Telegram chat. Login-scoped; the notice
// renders on Settings → Notifications until saveLoginTelegram clears it. The flag
// is one-shot by design — migration 105 is its ONLY writer, so there is no
// exported setter (#1869 item 3 removed the caller-less one).
export function getNotifyReviewNeeded(loginId: number): boolean {
  return getLoginSetting(loginId, "notify_review_needed") === "1";
}

export function clearNotifyReviewNeeded(loginId: number): void {
  setLoginSetting(loginId, "notify_review_needed", "0");
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

// ---- Bedtime wear reminder (issue #2161) — per-profile OPT-IN, off by default ----
// Whether this profile gets the one nightly "your watch hasn't recorded since X —
// still on the charger?" send at its Bedtime slot.
//
// This flag IS the consent. Sleep and HR are observation domains, so no obligation
// exists to hang a send on (docs/internals/findings.md §3), and the contact-consent
// rule permits a contact INCREASE only behind a user-owned declaration — this one, in
// the same position `obligation` occupies for a medication. Absent reads as OFF, and
// off is byte-for-byte today's behaviour: no send, no marker, no gather past the
// settings read.
//
// PROFILE tier, deliberately, and not the login tier the delivery channels use: "do I
// wear a device to sleep, and do I want to be asked about it" is a fact about the data
// SUBJECT, not about a phone. A caregiver reading two profiles gets the answer each of
// those profiles declared. Settings → Notifications is mixed-scope for exactly this
// reason (AGENTS.md).
//
// NOTHING WRITES THIS BUT A USER ACTION. A detected lost night may suggest turning it
// on; the suggestion is not the write.

export function getProfileWearReminder(profileId: number): boolean {
  return getProfileSetting(profileId, "wear_reminder_enabled") === "1";
}

export function setProfileWearReminder(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "wear_reminder_enabled", enabled ? "1" : "0");
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

// The check-in "Calm" (anxiety) scale opt-in (issue #1313, signal 6) — the escape
// hatch for a profile with no INFERABLE mental-health signal who nonetheless wants
// the daily anxiety rating. Off by default; the other five gate signals (prior use,
// GAD-7/PHQ-9 on record, an anxiety condition/med, a protocol outcome) reveal the
// scale on their own, so this is only load-bearing for the un-inferable case. The
// gate is SILENT (#716 law) — this stored flag is the ONLY place a "show the scale"
// intent is ever written; the inference bit is derived per render and never stored.
export function getAnxietyScaleOptIn(profileId: number): boolean {
  return getProfileSetting(profileId, "anxiety_scale_enabled") === "1";
}

export function setAnxietyScaleOptIn(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "anxiety_scale_enabled", enabled ? "1" : "0");
}

// ---- Morning-digest sleep summary (issue #1117) — per-profile, ON by default (#1378) ----
// Whether the morning digest includes a calm "how'd I sleep" section (last night's
// MAIN overnight session vs baseline, stage breakdown, an SRI note, any nap on its
// own line). ON by default whenever the digest is enabled (issue #1378): a user who
// deliberately enabled the morning digest has already asked to be briefed, and last
// night's sleep is the most morning-shaped content the app has — the old second opt-in
// (#992's over-cautious posture) hid the section from most digest users. So this is
// absent-means-ON: the toggle is now an opt-OUT. A stored "0" still means off; the key
// absent (never touched) now reads on. This is the ONE place the default lives — the
// Settings UI toggle and the digest gather (gatherDigestSleep) both read it, so the
// default can't drift (#221). The freshness + no-data gates in gatherDigestSleep are
// UNCHANGED: the section still collapses when there's no fresh sleep data even when on,
// so a profile without a sleep source sees zero new noise. A `digest_sleep_enabled`
// "1"/"0" flag in profile_settings.
export function getProfileSleepDigest(profileId: number): boolean {
  return getProfileSetting(profileId, "digest_sleep_enabled") !== "0";
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

// The pointer to the LAST household round this RECEIVER was sent (#1719) — the same
// mechanism, for the same reason, as the food-nudge pointer above: a surviving round
// keyboard from an earlier day would log a dose confirmation to YESTERDAY, for someone
// else's medication. One pointer per receiver profile, overwritten on every send.
export function getHouseholdRoundPointer(
  profileId: number
): HouseholdRoundPointer | null {
  return parseHouseholdRoundPointer(
    getProfileSetting(profileId, "household_round_last_message")
  );
}

export function setHouseholdRoundPointer(
  profileId: number,
  pointer: HouseholdRoundPointer
): void {
  setProfileSetting(
    profileId,
    "household_round_last_message",
    serializeHouseholdRoundPointer(pointer)
  );
}

// ---- The digest's live offer-tail keyboard (issue #1505) -------------------
//
// The digest carries the guaranteed offer tail, and that button's LABEL names the
// slot it opens into ("Log other (2 for bedtime)"). A morning-sent digest whose label
// still says "morning" at 10pm is a promise the expansion won't keep, so the tick
// re-labels it at each slot boundary.
//
// Doing that needs the sent message's id — the same thing the #947 food-nudge pointer
// keeps, for the same class of reason (a live keyboard outliving its context). One
// pointer per profile, overwritten every digest, no cleanup class: profile deletion
// wipes the settings row and ids never recycle, so a stale pointer is at worst a
// best-effort edit that fails harmlessly.
//
// `renderedAt` is the profile-local HH:MM the keyboard was last rendered at, which is
// what offerTailNeedsRefresh compares against so a boundary pass that changes nothing
// makes no API call.
export interface DigestTailPointer {
  chatId: string | number;
  messageId: number;
  date: string;
  renderedAt: string;
}

export function getDigestTailPointer(
  profileId: number
): DigestTailPointer | null {
  const raw = getProfileSetting(profileId, "digest_tail_last_message");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DigestTailPointer>;
    if (
      (typeof v.chatId !== "string" && typeof v.chatId !== "number") ||
      typeof v.messageId !== "number" ||
      typeof v.date !== "string" ||
      typeof v.renderedAt !== "string"
    ) {
      return null;
    }
    return {
      chatId: v.chatId,
      messageId: v.messageId,
      date: v.date,
      renderedAt: v.renderedAt,
    };
  } catch {
    // A corrupt blob degrades to null — the refresh simply skips this tick. It must
    // never throw on the delivery path.
    return null;
  }
}

export function setDigestTailPointer(
  profileId: number,
  pointer: DigestTailPointer
): void {
  setProfileSetting(
    profileId,
    "digest_tail_last_message",
    JSON.stringify(pointer)
  );
}

export function clearDigestTailPointer(profileId: number): void {
  deleteProfileSetting(profileId, "digest_tail_last_message");
}

// Resolve every profile an inbound Telegram chat id may act as — chat → LOGIN →
// in-scope profiles (issue #1072). A chat id now belongs to a LOGIN
// (login_settings.telegram_chat_id), and that login manages a set of profiles; a
// single family-group chat can be shared by several logins, so this unions every
// managing login's in-scope, non-muted profiles. Inbound button taps carry only a
// chat id, and the callback handler picks the one the button token names (rejecting
// taps from a chat that can't act as that profile).
//
// The "profiles this login manages" edge set is the SAME one the OUTBOUND fan-out
// uses — `profilesManagedByLogin` (login_profiles grants UNION own_profile_id, the
// inverse of managingLoginIdsForProfile) — so inbound and outbound can never
// disagree (#1365). Before the unification this joined only login_profiles, so a
// login whose access to a profile came solely via its own-profile association
// (#1013) received that profile's notifications but had every inbound tap refused.
// The per-(login, profile) mute (isProfileMutedForLogin — the same predicate the
// fan-out consults) holds a muted profile out of a login's inbound scope too.
// The logins whose Telegram channel IS this chat (a shared family chat can be
// several). Extracted so the inbound paths that need the LOGINS — not the profiles —
// share one query: the household round (#1459) must ask whether the tapping chat
// belongs to the receiving profile's own login, a question the profile-set view
// below has already flattened away.
export function loginIdsForTelegramChat(chatId: string): number[] {
  const chat = chatId.trim();
  if (!chat) return [];
  return (
    db
      .prepare(
        "SELECT login_id FROM login_settings WHERE key = 'telegram_chat_id' AND value = ?"
      )
      .all(chat) as { login_id: number }[]
  ).map((r) => r.login_id);
}

export function getProfilesByTelegramChatId(chatId: string): number[] {
  const chat = chatId.trim();
  if (!chat) return [];
  const loginIds = loginIdsForTelegramChat(chat);
  const profileIds = new Set<number>();
  for (const loginId of loginIds) {
    for (const profileId of profilesManagedByLogin(loginId)) {
      if (isProfileMutedForLogin(loginId, profileId)) continue;
      profileIds.add(profileId);
    }
  }
  return [...profileIds].sort((a, b) => a - b);
}

// Merged view (global bot config + this login's delivery channel), for the
// settings page and the "send test" path.
export interface NotificationConfig extends TelegramBotConfig, LoginTelegram {}

export function getNotificationConfig(loginId: number): NotificationConfig {
  return { ...getTelegramBotConfig(), ...getLoginTelegram(loginId) };
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

// Telegram column — per LOGIN (issue #1072: the Telegram chat belongs to the login,
// so which kinds reach it is the login's choice too), beside the login's
// telegram_enabled / chat id. A message for a profile fans out to every managing
// login's chat; each login's disabled set gates its own copy at the send seam.
export function getLoginTelegramDisabledKinds(
  loginId: number
): NotificationKind[] {
  return parseDisabledKinds(
    getLoginSetting(loginId, "telegram_notify_disabled_kinds")
  );
}

export function setLoginTelegramDisabledKinds(
  loginId: number,
  kinds: readonly NotificationKind[]
): void {
  setLoginSetting(
    loginId,
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

// Email column — per LOGIN (issue #1855: the inbox belongs to the login, exactly
// like the Telegram chat and the push subscription). A message for a profile fans
// out to every managing login's address; each login's disabled set gates its own
// copy at the send seam.
export function getLoginEmailDisabledKinds(
  loginId: number
): NotificationKind[] {
  return parseDisabledKinds(
    getLoginSetting(loginId, "email_notify_disabled_kinds")
  );
}

export function setLoginEmailDisabledKinds(
  loginId: number,
  kinds: readonly NotificationKind[]
): void {
  setLoginSetting(
    loginId,
    "email_notify_disabled_kinds",
    serializeDisabledKinds(kinds)
  );
}

// ---- Per-category digest demotion (#1714) ----
// "Demote" = notable-only, never hidden — the vocabulary and every predicate live in
// the pure ../notifications/digest-tune. Stored per LOGIN, beside the login's Telegram
// channel config: which lines a digest routinely carries is a DISPLAY preference of
// the person reading it, not a fact about the data subject. Two logins watching one
// profile therefore hold independent preferences. Plain KV, no schema change.

const DIGEST_DEMOTE_KEY = "digest_demoted_categories";

export function getLoginDigestDemotions(loginId: number): DigestCategory[] {
  return parseDigestDemotions(getLoginSetting(loginId, DIGEST_DEMOTE_KEY));
}

export function setLoginDigestDemotions(
  loginId: number,
  cats: readonly DigestCategory[]
): void {
  setLoginSetting(loginId, DIGEST_DEMOTE_KEY, serializeDigestDemotions(cats));
}

// Flip ONE category for ONE login and report the resulting state. Read-modify-write
// inside a single immediate transaction: the Telegram tap and the Settings mirror
// write the same row from different processes, and a last-write-wins read outside the
// lock could drop a concurrent toggle of a DIFFERENT category. Returns the typed
// outcome the caller answers from — never an unconditional "done" (AGENTS.md).
export function toggleLoginDigestDemotion(
  loginId: number,
  category: DigestCategory
): { demoted: boolean; categories: DigestCategory[] } {
  return writeTx(() => {
    const next = toggleDigestDemotion(
      parseDigestDemotions(getLoginSetting(loginId, DIGEST_DEMOTE_KEY)),
      category
    );
    setLoginSetting(loginId, DIGEST_DEMOTE_KEY, serializeDigestDemotions(next));
    return { demoted: next.includes(category), categories: next };
  });
}

// The demotion that applies to a PROFILE's one digest message. The message is built
// once and fans out to every managing login, so the per-login preferences collapse
// conservatively (intersectDigestDemotions): a category is demoted only when EVERY
// recipient declared it. No login is ever shown less than it asked for.
export function digestDemotionsForProfile(profileId: number): DigestCategory[] {
  return intersectDigestDemotions(
    managingLoginIdsForProfile(profileId).map(getLoginDigestDemotions)
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

// When each notification slot is sent. Supplement windows have a fixed minute of
// day (0-1439, interpreted in the profile's own timezone — see getTimezone, which
// the scheduler resolves against, not the container's local time) or null = off;
// the workout reminder's timing is derived from the user's history (see
// inferWorkoutSchedule), so it's just on/off here. Slot times moved from hours to
// minutes of day in #2121; the stored values are "HH:MM" (migration 158), and the
// hour-suffixed key names are kept — renaming six settings keys would buy nothing
// but a second migration surface.
export interface NotifySchedule {
  supplementMinutes: {
    Morning: number | null;
    Midday: number | null;
    Evening: number | null;
    Bedtime: number | null;
  };
  workoutEnabled: boolean;
  // Whether the Morning intake slot follows the profile's wake time (issue #1117).
  // When true, `supplementMinutes.Morning` above already holds the RESOLVED wake
  // minute (typicalWakeTime, or the hardcoded default when there's no sleep data
  // yet); this flag is what the settings form and the write path key on to persist
  // the "auto" sentinel instead of round-tripping the resolved number as a manual
  // choice. A manual time or "off" leaves this false.
  morningAuto: boolean;
  // Morning digest (#2211): the minute of day in this profile's timezone, or null =
  // off (opt-in — absent stays off). In Static mode this is the SEND TIME; in Dynamic
  // mode it is the FLOOR the digest is never sent before. There is no `auto` state
  // any more: a time is always a concrete minute the user typed or tapped, and #2217
  // is what proposes moving it.
  digestMinute: number | null;
  // Which of the two modes decides the send time. Stored separately from the minute
  // (`digest_mode`), deliberately NOT multiplexed as a third meaning onto
  // `notify_digest_hour` — that overload is what #2205 exists to stop. Absent reads
  // as Static, so a digest configured before modes existed is unchanged.
  digestMode: DigestMode;
  // Periodic recap (issues #32 / #2178): the weekday (0=Sun … 6=Sat, this profile's
  // timezone) the recap slot fires on, or null = off. Off by default. The recap fires
  // at weeklyRecapMinute on that weekday.
  //
  // This is the ONE slot every recap scale arrives in — a monthly or quarterly recap
  // does not get a send day of its own, which is what makes a longer cadence a contact
  // REDUCTION and never an increase (#2178's replace-never-stack rule).
  weeklyRecapDay: number | null;
  weeklyRecapMinute: number | null; // minute of day; defaults to 09:00 when a day is set
  // WHICH SCALE that slot speaks at (#2178): the shortest period the review may report
  // on. `week` (the default) hears from every scale as its periods close; `quarter`
  // hears only from the quarter. Profile-scoped CONTENT, beside the schedule — the
  // delivery channels stay login-scoped, per the mixed-scope Notifications model.
  recapScale: RecapScale;
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

// The default recap send time when a weekday is chosen (09:00).
const DEFAULT_RECAP_MINUTE = 9 * 60;

// Where the recap's SCALE lives (#2178) — its own key beside the weekday and the time,
// never multiplexed onto either. The two questions ("when does the slot fire" and "what
// length does it report on") are separate, and #2205's rule against overloading a
// schedule value with a second meaning applies here as much as it did to the digest.
export const RECAP_SCALE_KEY = "notify_recap_scale";

/**
 * The profile's chosen recap cadence. Absent/unreadable ⇒ `week`: the pre-#2178
 * default, and the safe direction — an unparseable setting must never SILENCE a review
 * the user turned on, only ever leave it where it was.
 */
export function getRecapScale(profileId: number): RecapScale {
  return parseRecapScale(getProfileSetting(profileId, RECAP_SCALE_KEY));
}

export function setRecapScale(profileId: number, scale: RecapScale): void {
  setProfileSetting(profileId, RECAP_SCALE_KEY, scale);
}

// Where the digest's MODE lives (#2211). Its own key beside `notify_digest_hour`,
// which keeps carrying only "" (off) or "HH:MM" — the two questions ("when" and
// "how does it decide when") are separate, and multiplexing a third meaning onto the
// time is exactly what #2205 exists to stop.
export const DIGEST_MODE_KEY = "digest_mode";

export function getNotifySchedule(profileId: number): NotifySchedule {
  const morningRaw = getProfileSetting(profileId, SUPP_HOUR_KEYS.Morning);
  const digestRaw = getProfileSetting(profileId, "notify_digest_hour");

  // The wake-derived Morning minute (issue #1117), computed only when the Morning
  // slot actually needs it — absent or "auto". A profile with an explicit manual
  // Morning time never pays the sleep read. At minute grain (#2121) the wake minute
  // is used AS IS: the old round-to-the-nearest-hour helper (wakeMinuteToHour) had
  // minutes and threw them away, and its rounding defect is deleted with it — a
  // 6:50 wake now seeds 6:50.
  //
  // This is the WAKE time, and it is the answer for the Morning INTAKE slot ONLY:
  // that slot needs you awake and has no dependency on sleep data having synced. The
  // morning DIGEST no longer reads it at all (#2211 removed `auto` from the digest),
  // so the arrival statistic is not gathered here either — it is a bound and a
  // suggestion now, never a live binding.
  const needsWake = morningRaw === undefined || morningRaw === AUTO_TIME;
  const wakeMinute = needsWake ? typicalWakeTime(profileId) : null;
  // Auto/absent Morning resolves to the wake minute, or the hardcoded default when
  // no sleep data yet — graceful degradation.
  const morningAutoValue =
    wakeMinute ?? DEFAULT_INTAKE_REMINDER_MINUTES.Morning;

  return {
    supplementMinutes: {
      // Morning: absent OR "auto" → wake-derived; "HH:MM" → manual (wins); "" → off.
      Morning: parseNotifyTime(morningRaw, morningAutoValue, morningAutoValue),
      Midday: parseNotifyTime(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Midday),
        DEFAULT_INTAKE_REMINDER_MINUTES.Midday
      ),
      Evening: parseNotifyTime(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Evening),
        DEFAULT_INTAKE_REMINDER_MINUTES.Evening
      ),
      Bedtime: parseNotifyTime(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Bedtime),
        DEFAULT_INTAKE_REMINDER_MINUTES.Bedtime
      ),
    },
    // The Morning slot is in auto mode when the stored value is the sentinel OR
    // absent (never configured) — both resolve to the wake time. A manual "HH:MM"
    // or an explicit "" (off) is not auto.
    morningAuto: morningRaw === undefined || morningRaw === AUTO_TIME,
    workoutEnabled:
      (getProfileSetting(profileId, "notify_workout_enabled") ?? "1") === "1",
    // Digest is opt-in: absent → off (null); "" → off; "HH:MM" → that minute.
    //
    // A RESIDUAL "auto" reads as the declared default rather than as off. Migration
    // 166 converts every stored sentinel, so the only way one can appear is an old
    // process writing it during a deploy overlap — and turning someone's digest off
    // is a worse answer to that than pre-filling the default it would have been
    // switched on with. (`AUTO_TIME` itself is very much alive: the Morning intake
    // slot above still resolves it.)
    digestMinute: parseNotifyTime(digestRaw, null, DIGEST_DEFAULT_MINUTE),
    digestMode: parseDigestMode(getProfileSetting(profileId, DIGEST_MODE_KEY)),
    // Weekly recap — off by default (opt-in). Weekday 0-6, else null.
    weeklyRecapDay: parseWeekday(
      getProfileSetting(profileId, "notify_recap_day")
    ),
    weeklyRecapMinute:
      parseNotifyTime(
        getProfileSetting(profileId, "notify_recap_hour"),
        DEFAULT_RECAP_MINUTE
      ) ?? DEFAULT_RECAP_MINUTE,
    recapScale: getRecapScale(profileId),
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
    const m = sched.supplementMinutes[k];
    // The Morning slot persists the "auto" sentinel when it's following the wake
    // time (issue #1117), so re-saving an unchanged form NEVER freezes the resolved
    // wake time into a manual choice — the blind-write pollution the read-resolution
    // depends on avoiding. All other slots (and Morning when manual/off) write an
    // "HH:MM" or "" as before. Auto wins over the resolved time carried alongside.
    const value =
      k === "Morning" && sched.morningAuto
        ? AUTO_TIME
        : m == null
          ? ""
          : formatNotifyTime(m);
    setProfileSetting(profileId, SUPP_HOUR_KEYS[k], value);
  }
  setProfileSetting(
    profileId,
    "notify_workout_enabled",
    sched.workoutEnabled ? "1" : "0"
  );
  // Digest (#2211): the time and the mode are two settings, written together. The
  // time is "HH:MM" or "" (off) — no sentinel. The MODE is written unconditionally,
  // including while the digest is off, so the stored pair is always total: a reader
  // never has to decide whether an absent mode beside an off time means "Static" or
  // "unset". It does NOT survive as a user-visible choice — the picker collapses Off
  // and mode into one select, so turning the digest back on asks for the mode again.
  setProfileSetting(
    profileId,
    "notify_digest_hour",
    sched.digestMinute == null ? "" : formatNotifyTime(sched.digestMinute)
  );
  setProfileSetting(profileId, DIGEST_MODE_KEY, sched.digestMode);
  setProfileSetting(
    profileId,
    "notify_recap_day",
    sched.weeklyRecapDay == null ? "" : String(sched.weeklyRecapDay)
  );
  setProfileSetting(
    profileId,
    "notify_recap_hour",
    formatNotifyTime(sched.weeklyRecapMinute ?? DEFAULT_RECAP_MINUTE)
  );
  // Written unconditionally, including while the recap is off, so the stored triple is
  // always total: a reader never has to decide whether an absent scale beside an off
  // weekday means "week" or "unset".
  setProfileSetting(profileId, RECAP_SCALE_KEY, sched.recapScale);
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

// ---- The two ONE-FIELD digest writes (#2217) -------------------------------
//
// The time suggestion's exits each perform exactly ONE write, and these are why they
// can. `setNotifySchedule` rewrites the whole schedule — correct for a form that
// renders the whole schedule, wrong for a one-tap accept, which must be provably
// unable to touch a slot time, a quiet-hours bound or a domain toggle the user did
// not open (#2217 constraint 1: one tap, one explicit write).
//
// Both take the value the CALLER re-derived from the live detector. Neither infers
// anything: a suggestion never writes, and these are only reached from a tap.

/** Set the digest's send time (Static) / floor (Dynamic) and nothing else. */
export function setDigestMinute(profileId: number, minute: number): void {
  setProfileSetting(profileId, "notify_digest_hour", formatNotifyTime(minute));
}

/** Set the digest's mode and nothing else — not the time, not the schedule. */
export function setDigestMode(profileId: number, mode: DigestMode): void {
  setProfileSetting(profileId, DIGEST_MODE_KEY, mode);
}
