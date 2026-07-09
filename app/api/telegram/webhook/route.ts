// Inbound Telegram webhook — receives inline-button taps when the app is
// publicly reachable (Settings → Notifications, "webhook" mode; the polling
// mode handles the same updates via getUpdates instead). Authenticated by the
// secret token Telegram echoes on every call. Always returns 200 quickly so
// Telegram doesn't retry.

import crypto from "node:crypto";
import { getTelegramBotConfig } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { createLogger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = createLogger("notifications");

// This endpoint is a single shared secret (not per-user), so we rate-limit by
// client IP to blunt a flood hitting the auth/JSON path. Legitimate inbound taps
// from Telegram are low-volume, so 120/min per source is comfortably generous.
const WEBHOOK_RATE_LIMIT = 120;
const WEBHOOK_RATE_WINDOW_MS = 60 * 1000;

// Client IP from X-Forwarded-For, the most specific identity available for this
// shared-secret endpoint. Use the RIGHTMOST hop: proxies APPEND the real client on
// the right, so leftmost entries are attacker-supplied and spoofable. This assumes
// a single trusted reverse proxy in front of the app — the rightmost value is the
// address that proxy actually observed and set.
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (
    xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() ?? "unknown"
  );
}

// Constant-time secret comparison (mirrors lib/integrations/connections.ts), so
// the inbound-auth check doesn't leak the secret via timing.
function secretMatches(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const rl = checkRateLimit(`telegram-webhook:${clientIp(req)}`, {
    limit: WEBHOOK_RATE_LIMIT,
    windowMs: WEBHOOK_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return new Response("too many requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });
  }

  const cfg = getTelegramBotConfig();
  // First inbound-auth check in the app: reject anything without the registered secret.
  if (
    !secretMatches(
      req.headers.get("x-telegram-bot-api-secret-token"),
      cfg.telegramWebhookSecret
    )
  ) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const update = await req.json();
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (e) {
    // Never 5xx — that would make Telegram retry. Log and ack.
    log.error("webhook error", { err: e instanceof Error ? e : String(e) });
  }
  return new Response("ok", { status: 200 });
}
