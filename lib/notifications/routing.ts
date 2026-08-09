// "Could a message ABOUT this profile reach anybody?" — the READING half of the #2173
// unroutable predicate. The decision itself is pure (lib/household-setup.ts); this fills
// its `RoutingFacts`.
//
// It is deliberately NOT `getChannels().some(c => c.isConfigured(profileId))`, for two
// reasons worth stating rather than rediscovering:
//
//   • The predicate needs the SHAPE of the gap, not just its existence — an empty edge
//     set sends the reader to the grant UI, a channel-less edge set sends them to
//     Settings → Notifications. `isConfigured` collapses both to `false`.
//   • `telegramChannel.isConfigured` excludes MUTED logins, and a mute must not read as
//     unroutable. A per-(login, profile) mute is a deliberate, warned choice — #1324's
//     `wouldMuteSilenceSafety` already tells the last unmuted caregiver what they are
//     doing — while unroutable is a routing gap nobody chose.
//
// Everything else is the same primitives the channels themselves gate on, so the two
// cannot drift on what "configured" means: the instance bot token / VAPID keys / SMTP
// config, plus the per-login row. `lib/__db_tests__/household-setup.test.ts` pins the
// agreement against the real `getChannels()` for the unmuted case.
//
// Auth-blind. These reads touch login/grant tables (`login_profiles`, `logins`,
// `login_settings`, `push_subscriptions`) — NOT profile-owned data — so there is no
// `profile_id` filter to apply in the owned-table sense; the profile filter lives in the
// edge-set query itself (lib/notifications/managing-logins.ts). The one profile-scoped
// read here (the Home Assistant webhook) goes through `getProfileHomeAssistant`.

import { db } from "../db";
import type { RoutingFacts } from "../household-setup";
import {
  getLoginEmailNotify,
  getLoginTelegram,
  getProfileHomeAssistant,
  getTelegramBotConfig,
} from "../settings";
import { isEmailConfigured } from "../settings/email";
import { isValidWebhookUrl } from "./home-assistant-core";
import { loginEmailAddress } from "./email";
import { managingLoginIdsForProfile } from "./managing-logins";
import { isPushConfigured } from "./push";

// `push_subscriptions` is LOGIN-owned (a browser endpoint belongs to a device, not to a
// data subject), so this is keyed by login id alone — the same basis the fan-out reads it
// on. LIMIT 1: presence is the whole question.
const HAS_PUSH_STMT = db.prepare(
  "SELECT 1 FROM push_subscriptions WHERE login_id = ? LIMIT 1"
);

// Whether this LOGIN has at least one configured personal notification channel. Each
// clause pairs the INSTANCE-level precondition with the login's own row, exactly as the
// matching channel's `isConfigured` does.
export function loginHasAnyChannel(loginId: number): boolean {
  const { telegramBotToken } = getTelegramBotConfig();
  if (telegramBotToken) {
    const tg = getLoginTelegram(loginId);
    if (tg.telegramEnabled && tg.telegramChatId.trim()) return true;
  }
  if (isPushConfigured() && HAS_PUSH_STMT.get(loginId)) return true;
  if (isEmailConfigured()) {
    const mail = getLoginEmailNotify(loginId);
    if (mail.emailEnabled && loginEmailAddress(loginId)) return true;
  }
  return false;
}

export function profileRoutingFacts(profileId: number): RoutingFacts {
  const managingLoginIds = managingLoginIdsForProfile(profileId);
  const ha = getProfileHomeAssistant(profileId);
  return {
    managingLoginIds,
    channelledLoginIds: managingLoginIds.filter(loginHasAnyChannel),
    // Home Assistant is the one PROFILE-scoped channel: it delivers with no managing
    // login at all, so a profile that has one is routable even with an empty edge set.
    profileChannelConfigured: ha.enabled && isValidWebhookUrl(ha.webhookUrl),
  };
}
