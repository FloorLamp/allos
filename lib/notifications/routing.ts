// "Could a message ABOUT this profile reach anybody?" — the READING half of the #2173
// unroutable predicate. The decision itself is pure (lib/household-setup.ts); this fills
// its `RoutingFacts`.
//
// TWO SCOPES LIVE HERE, deliberately side by side. `loginHasAnyChannel` /
// `profileRoutingFacts` answer it about ONE profile; `instanceHasAnyChannel` answers
// "is any channel technology configured anywhere on this INSTANCE" — the gate the owner
// ruling on PR #2362 put in front of the whole predicate, which is a fact about the
// server evaluated once, not a fold over profiles. Both surfaces that report unroutable
// reach it through `profileRoutingFacts`, so neither owns a copy of it.
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
import { cache } from "../request-cache";
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

// THE INSTANCE-LEVEL HALF of each personal channel — the technology an operator
// configures once for the whole server, which a login's own row is then useless without.
// Declared ONCE, here, because two questions read it at two scopes and must not drift:
// `loginHasAnyChannel` pairs each one with that login's row, and
// `instanceHasAnyChannel` below asks whether ANY of them exists at all.
const INSTANCE_CHANNEL_TECHNOLOGY = {
  telegram: () => getTelegramBotConfig().telegramBotToken.trim() !== "",
  push: isPushConfigured,
  email: isEmailConfigured,
} as const;

// Whether this LOGIN has at least one configured personal notification channel. Each
// clause pairs the INSTANCE-level precondition with the login's own row, exactly as the
// matching channel's `isConfigured` does.
export function loginHasAnyChannel(loginId: number): boolean {
  if (INSTANCE_CHANNEL_TECHNOLOGY.telegram()) {
    const tg = getLoginTelegram(loginId);
    if (tg.telegramEnabled && tg.telegramChatId.trim()) return true;
  }
  if (INSTANCE_CHANNEL_TECHNOLOGY.push() && HAS_PUSH_STMT.get(loginId))
    return true;
  if (INSTANCE_CHANNEL_TECHNOLOGY.email()) {
    const mail = getLoginEmailNotify(loginId);
    if (mail.emailEnabled && loginEmailAddress(loginId)) return true;
  }
  return false;
}

// Every profile on the instance. `profiles` is a GLOBAL table (not profile-owned data),
// which is why this carries no `profile_id` filter — the ids are the value being read.
const ALL_PROFILE_IDS_STMT = db.prepare("SELECT id FROM profiles ORDER BY id");

// IS ANY CHANNEL TECHNOLOGY CONFIGURED ANYWHERE ON THIS INSTANCE? One fact about the
// SERVER, and the gate the owner ruling on PR #2362 put in front of `unroutable` — see
// `routingGap` (lib/household-setup.ts) for the reasoning it encodes.
//
// Three of the four channels answer it from `INSTANCE_CHANNEL_TECHNOLOGY` above — the
// same source `loginHasAnyChannel` reads, never a restatement of it. A configured
// technology that no login has enabled still opens the gate: "notifications are set up
// and nobody turned one on" IS the defect this reports, and the CTA already lands on the
// form that fixes it.
//
// HOME ASSISTANT IS THE FOURTH, and it needs its own sweep rather than dropping out.
// It has no instance-level half — the per-profile webhook is the whole configuration —
// so the instance question for it is whether ANY profile has one. Leaving it out would
// be wrong for the household the ruling is about: on an HA-only instance, the profile
// with the webhook is routable through `profileChannelConfigured` and never reaches this
// gate, but its SIBLING with no route is exactly the "notifications are set up, and this
// member cannot be reached by them" case the check exists to name, and it would be
// silenced. The sweep is a fold over CONFIGURATION, never over verdicts: it says nothing
// about whether any particular member is routable, and it is reached only when the other
// three are absent.
//
// Request-memoized: `/household` asks it once per member and Settings → Notifications
// once more, and the answer is identical for all of them.
export const instanceHasAnyChannel = cache(instanceHasAnyChannelUncached);

function instanceHasAnyChannelUncached(): boolean {
  if (Object.values(INSTANCE_CHANNEL_TECHNOLOGY).some((has) => has()))
    return true;
  return (ALL_PROFILE_IDS_STMT.all() as { id: number }[]).some(({ id }) => {
    const ha = getProfileHomeAssistant(id);
    return ha.enabled && isValidWebhookUrl(ha.webhookUrl);
  });
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
    // Carried on every profile's facts, identical for all of them — the decision is
    // pure, so the gate has to reach it as data.
    instanceHasAnyChannel: instanceHasAnyChannel(),
  };
}
