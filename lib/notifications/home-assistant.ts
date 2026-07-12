// Home Assistant notification channel (issue #248) — the third delivery channel
// beside Telegram and Web Push. It POSTs the rendered message to a per-profile HA
// webhook (HA's built-in webhook trigger — no custom component needed) so an HA
// automation can present it with what only HA knows: who is home, which room. The
// pure half (payload shape, dose extraction, per-kind toggle, URL validation) lives
// in ./home-assistant-core; this file is the DB reads + the outbound fetch.
//
// SCOPE: per-profile (like a Telegram chat id — a webhook points at one household's
// HA), stored in profile_settings via getProfileHomeAssistant. There is no global HA
// config. The channel joins the channel-aware delivery-health marker (#192) under the
// id "home-assistant" automatically, since dispatch() folds every channel's outcome
// into it.
//
// PHI posture: the body carries medication names (title/body) and typically travels
// LAN-to-LAN. An optional shared-secret header lets HA verify the caller; the docs
// recommend an https HA URL when the instances aren't co-located.

import { db } from "../db";
import { getProfileHomeAssistant } from "../settings";
import { createLogger } from "../log";
import type { NotificationChannel, NotificationMessage } from "./types";
import {
  buildHomeAssistantPayload,
  isKindEnabled,
  isValidWebhookUrl,
  isAcceptableWebhookStatus,
  HA_SECRET_HEADER,
} from "./home-assistant-core";

const log = createLogger("home-assistant");

// The tracked person's short display name (profiles.name) for the payload's
// `profile` field. profiles is a GLOBAL table (not profile-owned data), so this
// read is intentionally not profile_id-scoped — it IS keyed by the profile id.
function profileDisplayName(profileId: number): string {
  const row = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name?: string } | undefined;
  return row?.name ?? "";
}

// POST the payload to the HA webhook. Throws on any non-2xx (or transport error) so
// dispatch() records the channel failed and the delivery-health marker is set. A
// 10s timeout guards a hung LAN request. The shared secret, when set, rides the
// X-Allos-Webhook-Secret header (never in the body).
//
// SSRF hardening (issue #502): `redirect: "manual"` so Node's fetch NEVER follows a
// 3xx. isValidWebhookUrl (#371) only constrains the CONFIGURED url at save time — a
// profile editor could still point it at a host that answers 302 Location:
// http://169.254.169.254/… and the default redirect-following fetch would re-POST the
// medication-bearing payload to that internal target. With manual redirect a 3xx
// arrives here as a non-2xx status and is rejected below, so the request only ever
// reaches the exact validated URL, never a redirect target.
async function postWebhook(
  url: string,
  secret: string,
  payload: unknown
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) headers[HA_SECRET_HEADER] = secret;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!isAcceptableWebhookStatus(res.status)) {
    throw new Error(`Home Assistant webhook failed: HTTP ${res.status}`);
  }
}

// Build + POST the payload for one message, honoring the per-kind toggle. Returns
// whether the message was actually sent (false = this kind is toggled off for the
// channel, a deliberate no-op, not a failure). Shared by the channel send and the
// send-test action.
async function deliver(
  profileId: number,
  msg: NotificationMessage
): Promise<boolean> {
  const cfg = getProfileHomeAssistant(profileId);
  if (!isKindEnabled(msg.kind, cfg.disabledKinds)) return false;
  const payload = buildHomeAssistantPayload(msg, {
    profileId,
    profileName: profileDisplayName(profileId),
    sentAt: new Date().toISOString(),
  });
  await postWebhook(cfg.webhookUrl, cfg.secret, payload);
  return true;
}

export const homeAssistantChannel: NotificationChannel = {
  id: "home-assistant",
  isConfigured(profileId: number) {
    const cfg = getProfileHomeAssistant(profileId);
    return cfg.enabled && isValidWebhookUrl(cfg.webhookUrl);
  },
  async send(profileId: number, msg: NotificationMessage) {
    const sent = await deliver(profileId, msg);
    if (!sent) {
      // A kind toggled off for this channel is a no-op success (mirrors the push
      // channel's "no live subscription" case) — the fan-out counts it healthy.
      log.info("skipped: kind disabled for HA channel", {
        profile: profileId,
        kind: msg.kind ?? "other",
      });
    }
  },
};

// Send a test announcement to the profile's HA webhook, bypassing dispatch()'s
// fan-out so the user can verify the HA wiring independently of Telegram/push
// (mirrors sendTestPushToLogin). Returns "not-configured" when no valid webhook is
// set; "sent" once the POST succeeds; throws are surfaced to the caller as the
// failure reason. A `test` message is never gated by the per-kind toggle.
export async function sendHomeAssistantTest(
  profileId: number
): Promise<"not-configured" | "sent"> {
  if (!homeAssistantChannel.isConfigured(profileId)) return "not-configured";
  await deliver(profileId, {
    title: "Test notification",
    body: "Home Assistant webhook is working ✅",
    kind: "test",
  });
  return "sent";
}
