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
