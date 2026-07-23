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
// The DB reads here are login/grant tables (login_profiles, login_settings) — NOT
// profile-owned data — so they are not (and cannot be) profile_id-scoped in the
// owned-table sense; the profile filter lives in the grant subquery. The pure
// dedup half (dedupeRecipientsByChat) is unit-tested; the DB resolution is covered
// in the DB tier.

import { db } from "../db";
import { getLoginTelegram, isProfileMutedForLogin } from "../settings";

// A resolved Telegram delivery recipient: the login whose channel carries the
// message and the chat id it lands in. One per DISTINCT chat after dedup — a
// family group chat that several logins point at gets ONE message, not one per
// login (delivery dedupes by resolved chat id).
export interface TelegramRecipient {
  loginId: number;
  chatId: string;
}

// The logins that MANAGE a profile for the purpose of notification fan-out:
// explicit login_profiles grants UNION the login whose OWN profile this is
// (`logins.own_profile_id`, #1013). Admin role is deliberately NOT a source here —
// see the module header. A login sees its own profile's notifications even without
// an explicit self-grant (the #1013 own-profile association is the caregiver's own
// tracked self). Ordered by login id so "first login wins" in the chat dedup is
// stable and distinct so a login granted AND owning the profile appears once.
export function managingLoginIdsForProfile(profileId: number): number[] {
  const rows = db
    .prepare(
      `SELECT login_id FROM login_profiles WHERE profile_id = ?
       UNION
       SELECT id AS login_id FROM logins WHERE own_profile_id = ?
       ORDER BY login_id`
    )
    .all(profileId, profileId) as { login_id: number }[];
  return rows.map((r) => r.login_id);
}

// Collapse a recipient list to ONE entry per distinct, non-empty chat id (issue
// #1072 "delivery dedupes by resolved chat-id"): a shared family-group chat that
// several logins target must receive a single message, not one per login. The
// FIRST login (input order — managingLoginIdsForProfile is id-ordered) owns the
// chat, so the choice is deterministic. Empty chat ids are dropped (an enabled
// login with no chat configured is not a deliverable recipient). Pure — unit-tested.
export function dedupeRecipientsByChat(
  recipients: readonly TelegramRecipient[]
): TelegramRecipient[] {
  const seen = new Set<string>();
  const out: TelegramRecipient[] = [];
  for (const r of recipients) {
    const chat = r.chatId.trim();
    if (!chat || seen.has(chat)) continue;
    seen.add(chat);
    out.push({ loginId: r.loginId, chatId: chat });
  }
  return out;
}

// Every Telegram recipient a message ABOUT `profileId` should reach: each managing
// login that (a) has Telegram enabled with a chat id and (b) has NOT muted this
// profile, deduped by resolved chat id. This is the delivery audience the Telegram
// channel fans out over — the login owns the channel, the profile is the subject.
export function resolveTelegramRecipients(
  profileId: number
): TelegramRecipient[] {
  const recipients: TelegramRecipient[] = [];
  for (const loginId of managingLoginIdsForProfile(profileId)) {
    if (isProfileMutedForLogin(loginId, profileId)) continue;
    const { telegramEnabled, telegramChatId } = getLoginTelegram(loginId);
    if (!telegramEnabled || !telegramChatId.trim()) continue;
    recipients.push({ loginId, chatId: telegramChatId });
  }
  return dedupeRecipientsByChat(recipients);
}
