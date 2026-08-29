// DB INTEGRATION TIER — the needs_reauth connection-state transition (issue #326).
//
// A dead/revoked refresh token (or Oura PAT) must flip integration_connections.status
// to `needs_reauth` so the hourly tick — which auto-syncs `connected` rows ONLY —
// stops re-attempting the doomed refresh forever. A TRANSIENT failure (429/5xx) must
// NOT transition. Reconnecting (setStravaTokens/setOuraToken/setWithingsTokens) clears
// it back to `connected`. Fetch is stubbed; runs under vitest.db.config.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getConnection,
  getStravaAccessToken,
  setStravaCredentials,
  setStravaTokens,
  getWithingsAccessToken,
  setWithingsCredentials,
  setWithingsTokens,
  setOuraToken,
} from "@/lib/integrations/connections";
import { runOuraSync } from "@/lib/integrations/oura-sync";
import { syncIntegrations } from "@/lib/integrations/pull-tick";

let profileId: number;
let fetchMock: ReturnType<typeof vi.fn>;

function statusOf(provider: string): string | undefined {
  return getConnection(profileId, provider)?.status;
}

// A past expiry so getStrava/WithingsAccessToken always take the refresh branch.
const EXPIRED = Math.floor(Date.now() / 1000) - 3600;

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('REAUTH')").run()
      .lastInsertRowid
  );
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Strava refresh failure → needs_reauth", () => {
  beforeEach(() => {
    setStravaCredentials(profileId, "client-id", "client-secret");
    setStravaTokens(profileId, {
      accessToken: "dead-access",
      refreshToken: "dead-refresh",
      expiresAt: EXPIRED,
    });
    expect(statusOf("strava")).toBe("connected");
  });

  it("flips to needs_reauth on a 400 invalid_grant", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    );
    await expect(getStravaAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("strava")).toBe("needs_reauth");
  });

  it("flips to needs_reauth on a 401", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(getStravaAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("strava")).toBe("needs_reauth");
  });

  it("stays connected on a transient 500", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream error", { status: 500 })
    );
    await expect(getStravaAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("strava")).toBe("connected");
  });

  it("reconnecting clears needs_reauth back to connected", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(getStravaAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("strava")).toBe("needs_reauth");

    setStravaTokens(profileId, {
      accessToken: "fresh",
      refreshToken: "fresh-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(statusOf("strava")).toBe("connected");
  });

  it("preserves the entered client credentials across the transition", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(getStravaAccessToken(profileId)).rejects.toThrow();
    const cfg = JSON.parse(getConnection(profileId, "strava")!.config!);
    expect(cfg.clientId).toBe("client-id");
    expect(cfg.clientSecret).toBe("client-secret");
  });
});

describe("Withings refresh failure → needs_reauth", () => {
  beforeEach(() => {
    setWithingsCredentials(profileId, "w-client", "w-secret");
    setWithingsTokens(profileId, {
      accessToken: "dead-access",
      refreshToken: "dead-refresh",
      expiresAt: EXPIRED,
    });
    expect(statusOf("withings")).toBe("connected");
  });

  it("flips on an envelope status 401 (HTTP 200)", async () => {
    // Withings rides auth errors in its { status } envelope over HTTP 200.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 401 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(getWithingsAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("withings")).toBe("needs_reauth");
  });

  it("stays connected on an over-quota envelope status 601", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 601 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(getWithingsAccessToken(profileId)).rejects.toThrow();
    expect(statusOf("withings")).toBe("connected");
  });
});

describe("Oura revoked PAT → needs_reauth", () => {
  beforeEach(() => {
    setOuraToken(profileId, "dead-token");
    expect(statusOf("oura")).toBe("connected");
  });

  it("flips to needs_reauth when the data pull 401s", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const res = await runOuraSync(profileId);
    expect(res).toHaveProperty("error");
    expect(statusOf("oura")).toBe("needs_reauth");
  });

  it("stays connected on a transient 500 pull failure", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream error", { status: 500 })
    );
    const res = await runOuraSync(profileId);
    expect(res).toHaveProperty("error");
    expect(statusOf("oura")).toBe("connected");
  });
});

// ---- #3798: at the refresh door, "revoked" needs evidence, not its absence -------
//
// A bodyless or non-JSON HTTP 400 is what a CDN/gateway artifact in front of a token
// endpoint looks like — and it used to reach `needs_reauth`, which since #3618 tells
// the person their connection expired and, via pull-tick's `status !== "connected"`
// skip, stops syncing that source until they act on an instruction that was false.
// Both directions are pinned here: absence of evidence leaves the connection alone,
// and a body that DOES name the rejected grant still flips it.
const GATEWAY_HTML =
  "<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudfront</center></body></html>";
// Strava spells a dead refresh token as a field reference, not the bare OAuth code.
const STRAVA_DEAD_GRANT =
  '{"message":"Bad Request","errors":[{"resource":"RefreshToken","field":"refresh_token","code":"invalid"}]}';

// A body that cannot be read at all: the stream errors on first pull, so `res.text()`
// REJECTS rather than returning "". Distinct from an empty body, which reads fine and
// says nothing — this one is the read itself failing.
function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error("body stream cut"));
    },
  });
}

async function refreshWith(
  provider: "strava" | "withings",
  body: BodyInit,
  status: number
) {
  fetchMock.mockResolvedValue(new Response(body, { status }));
  const call =
    provider === "strava"
      ? getStravaAccessToken(profileId)
      : getWithingsAccessToken(profileId);
  await expect(call).rejects.toThrow();
}

describe("refresh door — a 400 is a dead grant only on evidence (#3798)", () => {
  beforeEach(() => {
    setStravaCredentials(profileId, "client-id", "client-secret");
    setStravaTokens(profileId, {
      accessToken: "dead-access",
      refreshToken: "dead-refresh",
      expiresAt: EXPIRED,
    });
    setWithingsCredentials(profileId, "w-client", "w-secret");
    setWithingsTokens(profileId, {
      accessToken: "dead-access",
      refreshToken: "dead-refresh",
      expiresAt: EXPIRED,
    });
  });

  it.each([
    // No evidence at all — the gateway artifact this issue is about.
    ["strava", "", "connected"],
    ["strava", GATEWAY_HTML, "connected"],
    ["withings", "", "connected"],
    ["withings", GATEWAY_HTML, "connected"],
    // THE CONVERSE: a real revocation still reaches needs_reauth on each provider.
    ["strava", STRAVA_DEAD_GRANT, "needs_reauth"],
    ["withings", '{"error":"invalid_grant"}', "needs_reauth"],
  ] as const)("%s HTTP 400 + %j → %s", async (provider, body, expected) => {
    await refreshWith(provider, body, 400);
    expect(statusOf(provider)).toBe(expected);
  });

  // THE CONSEQUENCE, not just the column: pull-tick auto-syncs `connected` rows only,
  // so the gateway 400 must leave the source in the next tick's poll set and a real
  // revocation must take it out. This is the difference the person actually feels.
  it.each([
    ["", true],
    [STRAVA_DEAD_GRANT, false],
  ] as const)(
    "after a 400 %j the next tick polls strava: %s",
    async (body, stillPolled) => {
      await refreshWith("strava", body, 400);
      fetchMock.mockResolvedValue(
        new Response("upstream error", { status: 500 })
      );
      const tick = await syncIntegrations(profileId);
      expect(tick.polled.includes("strava")).toBe(stillPolled);
    }
  );

  // A 401 IS THE ONE STATUS THAT NEEDS NO EVIDENCE, so no evidence must not be able to
  // swallow it. Both doors read the body before they branch, and a body that arrives as
  // a broken stream throws out of that read — which, uncaught, skips
  // `markConnectionNeedsReauth` and leaves a revoked grant `connected` for pull-tick to
  // retry every hour forever. Both providers, because the invariant is the door's and
  // not one call site's.
  it.each(["strava", "withings"] as const)(
    "%s HTTP 401 flips to needs_reauth even when the body read throws",
    async (provider) => {
      await refreshWith(provider, unreadableBody(), 401);
      expect(statusOf(provider)).toBe("needs_reauth");
    }
  );
});
