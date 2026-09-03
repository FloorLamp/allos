// Login-scoped notification fan-out (issue #1072). Notification CHANNELS belong to
// LOGINS (people), not profiles (data subjects): a toddler has no phone, their
// caregiver does. A per-profile EVENT (a dose reminder, a missed-dose escalation,
// a digest) is ABOUT a profile but RIDES a login's channel, so delivery fans the
// event out to every login that MANAGES that profile.
//
// FAN-OUT SCOPE — the one deliberate departure from admin-sees-all. The set of
// managing logins is the EXPLICIT grants (login_profiles) PLUS the login's own
// profile (#1013, null until that lands) — NEVER the admin-bypass-all rule. An
// admin who can act as every profile must NOT receive every profile's dose
// reminders; they opt specific profiles into their notification scope by granting
// themselves (or, once #1013 lands, via their own-profile association). This is the
// single place the "admins reach every profile" rule is intentionally not inherited
// — a notification is a push into someone's pocket, not a read.
//
// That opt-in is PERFORMABLE since #2345: `setGrants` used to refuse every admin
// ("Admins already have access to every profile" — true about access, irrelevant to
// notifications), so the sentence above described a write nothing could make. An
// admin's `login_profiles` row now means exactly "notify me about this profile", and
// the control for it renders on Settings → Family (any login) and Settings →
// Notifications (the signed-in one). Nothing here changed: the exclusion stands, and
// an admin still receives only what they explicitly checked.
//
// The DB reads here are login/grant tables (login_profiles, login_settings) — NOT
// profile-owned data — so they are not (and cannot be) profile_id-scoped in the
// owned-table sense; the profile filter lives in the grant subquery. The pure
// dedup half (dedupeRecipientsByChat) is unit-tested; the DB resolution is covered
// in the DB tier.

import { getLoginTelegram, isProfileMutedForLogin } from "../settings";
import { managingLoginIdsForProfile } from "./managing-logins";

// Re-exported so existing importers of the fan-out keep their path (#1365 moved the
// edge-set definition into ./managing-logins so the inbound direction shares it).
export { managingLoginIdsForProfile } from "./managing-logins";

// A resolved Telegram delivery recipient: the login whose channel carries the
// message and the chat id it lands in. One per DISTINCT chat after dedup — a
// family group chat that several logins point at gets ONE message, not one per
// login (delivery dedupes by resolved chat id).
export interface TelegramRecipient {
  loginId: number;
  chatId: string;
}

// One distinct chat and EVERY login mapped to it, first login first. The send goes to
// the chat once; the outcome belongs to all of them (#2565: a shared chat applies the
// one send outcome to every deduped login).
export interface TelegramChat {
  chatId: string;
  loginIds: number[];
}

// Group a recipient list by distinct, non-empty chat id (issue #1072 "delivery dedupes
// by resolved chat-id"): a shared family-group chat that several logins target must
// receive a single message, not one per login. Input order is kept (first-seen chat
// first, first login first — managingLoginIdsForProfile is id-ordered), so the choice
// of owning login is deterministic. Empty chat ids are dropped (an enabled login with
// no chat configured is not a deliverable recipient). Pure — unit-tested.
export function groupRecipientsByChat(
  recipients: readonly TelegramRecipient[]
): TelegramChat[] {
  const byChat = new Map<string, TelegramChat>();
  for (const r of recipients) {
    const chat = r.chatId.trim();
    if (!chat) continue;
    const group = byChat.get(chat);
    if (group) group.loginIds.push(r.loginId);
    else byChat.set(chat, { chatId: chat, loginIds: [r.loginId] });
  }
  return [...byChat.values()];
}

// The collapse the rest of the fan-out speaks in: one recipient per chat, the FIRST
// login owning it.
export function dedupeRecipientsByChat(
  recipients: readonly TelegramRecipient[]
): TelegramRecipient[] {
  return groupRecipientsByChat(recipients).map((g) => ({
    loginId: g.loginIds[0],
    chatId: g.chatId,
  }));
}

// Would muting `actingLoginId` leave NO unmuted managing login for this profile? The
// "last unmuted managing login" predicate (#1324) — the mute-path analog of the
// notification matrix's all-off-safety warning. When every OTHER managing login is
// already muted, this login is the sole remaining unmuted caregiver, so muting it here
// routes the profile's SAFETY tier (dose reminders / missed-dose escalation) to nobody.
// Pure — unit-tested. Warn, never block: the caller may genuinely want it (a single-
// caregiver household that deliberately mutes).
export function isLastUnmutedManagingLogin(
  managingLoginIds: readonly number[],
  mutedLoginIds: ReadonlySet<number>,
  actingLoginId: number
): boolean {
  // A login that doesn't manage the profile can't be its last unmuted caregiver.
  if (!managingLoginIds.includes(actingLoginId)) return false;
  // Muting `actingLoginId` empties the unmuted set iff every other managing login is
  // already muted.
  return managingLoginIds.every(
    (id) => id === actingLoginId || mutedLoginIds.has(id)
  );
}

// Whether muting this profile for THIS login would silence the profile's safety tier for
// everyone (#1324) — the DB resolution over the SAME managing-login set the fan-out uses.
// Consults each OTHER managing login's mute state (this login's own current mute state is
// irrelevant: the question is what remains once it mutes). The matrix's all-off-safety
// warning re-homed on the per-(login, profile) mute path.
export function wouldMuteSilenceSafety(
  loginId: number,
  profileId: number
): boolean {
  const managing = managingLoginIdsForProfile(profileId);
  const mutedOthers = new Set(
    managing.filter(
      (id) => id !== loginId && isProfileMutedForLogin(id, profileId)
    )
  );
  return isLastUnmutedManagingLogin(managing, mutedOthers, loginId);
}

// Every Telegram recipient a message ABOUT `profileId` should reach: each managing
// login that (a) has Telegram enabled with a chat id and (b) has NOT muted this
// profile, deduped by resolved chat id. This is the delivery audience the Telegram
// channel fans out over — the login owns the channel, the profile is the subject.
export function resolveTelegramRecipients(
  profileId: number
): TelegramRecipient[] {
  return resolveTelegramChats(profileId).map((g) => ({
    loginId: g.loginIds[0],
    chatId: g.chatId,
  }));
}

// The same audience, one entry per chat with EVERY login mapped to it — what the
// Telegram channel sends over, so the outcome it records reaches each of them.
export function resolveTelegramChats(profileId: number): TelegramChat[] {
  const recipients: TelegramRecipient[] = [];
  for (const loginId of managingLoginIdsForProfile(profileId)) {
    if (isProfileMutedForLogin(loginId, profileId)) continue;
    const { telegramEnabled, telegramChatId } = getLoginTelegram(loginId);
    if (!telegramEnabled || !telegramChatId.trim()) continue;
    recipients.push({ loginId, chatId: telegramChatId });
  }
  return groupRecipientsByChat(recipients);
}
