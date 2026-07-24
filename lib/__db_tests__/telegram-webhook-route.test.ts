// DB INTEGRATION TIER — boundary NEGATIVE tests for the inbound Telegram webhook
// route handler (issue #1210). This is the app's FIRST inbound-auth check: a single
// shared secret Telegram echoes on every call. It was exercised only where an e2e
// happy path happened to traverse it; nothing pinned the DENIALS. A regression here
// (a dropped secret compare, an inverted rate-limit) turns the webhook into an
// unauthenticated command surface.
//
// Drives the REAL POST handler against the in-memory DB (the schema is booted by the
// db-tier setup) with only the request synthesized. The secret comes from
// setTelegramBotConfig (which mints a stable webhook secret), so this proves the
// route rejects a MISSING and a WRONG secret with a uniform 401 and no oracle, trips
// the per-client rate limit BEFORE the auth check, and answers 200 to a correctly-
// authenticated (empty) update.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "@/app/api/telegram/webhook/route";
import { setTelegramBotConfig, getTelegramBotConfig } from "@/lib/settings";

let secret: string;
const savedTrustProxy = process.env.TRUST_PROXY;

function webhookRequest(
  headers: Record<string, string> = {},
  body: unknown = {}
): Request {
  return new Request("http://x/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  // Minting the bot config generates the stable webhook secret the route compares
  // against. A synthetic token — never a real bot token (PHI/secret rules).
  setTelegramBotConfig({
    telegramBotToken: "111111:e2e-fake-bot-token",
    telegramMode: "webhook",
  });
  secret = getTelegramBotConfig().telegramWebhookSecret;
  expect(secret).toBeTruthy();
});

afterAll(() => {
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
});

describe("telegram webhook route — inbound-auth denials (#1210)", () => {
  it("rejects a request with NO secret header (401, generic body)", async () => {
    const res = await POST(webhookRequest());
    expect(res.status).toBe(401);
    // No oracle: the body is a bare, generic string — never echoes the secret or
    // says whether one was expected.
    const text = await res.text();
    expect(text).toBe("unauthorized");
    expect(text).not.toContain(secret);
  });

  it("rejects a request with a WRONG secret (401), same response as a missing one", async () => {
    const res = await POST(
      webhookRequest({ "x-telegram-bot-api-secret-token": "not-the-secret" })
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("rejects a secret of the WRONG length without throwing (constant-time compare guard)", async () => {
    // timingSafeEqual throws on unequal buffer lengths; the route's length guard
    // must short-circuit to a plain 401 rather than 500.
    const res = await POST(
      webhookRequest({ "x-telegram-bot-api-secret-token": `${secret}extra` })
    );
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-authenticated (empty) update with 200", async () => {
    // The correct secret passes the gate; an update with neither callback_query nor
    // message routes to no handler, so this asserts the auth path alone (no network).
    const res = await POST(
      webhookRequest({ "x-telegram-bot-api-secret-token": secret })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("telegram webhook route — rate limit precedes auth (#1210)", () => {
  it("trips 429 under a flood, before the secret is ever checked", async () => {
    // Isolate a fresh rate-limit bucket: with a trusted proxy the limiter keys on the
    // rightmost X-Forwarded-For entry, so a unique synthetic client (TEST-NET-3,
    // RFC 5737) gets its own bucket untouched by the auth tests above.
    process.env.TRUST_PROXY = "1";
    const xff = "203.0.113.77";
    const statuses: number[] = [];
    // Fire (with NO secret) until the limiter trips or a generous cap is hit — the
    // exact per-window budget is an internal constant, so don't hardcode it.
    for (let i = 0; i < 500; i++) {
      const res = await POST(
        webhookRequest({ "x-forwarded-for": xff }) // no secret header
      );
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    const firstTrip = statuses.indexOf(429);
    // The limiter DID trip within the cap…
    expect(firstTrip).toBeGreaterThan(0);
    // …and every request BEFORE it was a 401 (rate-limit is checked first, so a
    // pre-trip request reaches the secret compare and fails auth), never a 200 — the
    // flood never authenticated.
    expect(statuses.slice(0, firstTrip).every((s) => s === 401)).toBe(true);
  });
});
