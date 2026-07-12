// DB INTEGRATION TIER — single-flight OAuth token refresh (issue #470).
//
// Strava/Withings ROTATE the refresh token on refresh, so two processes refreshing the
// same connection at once (web "Sync now" + the hourly tick) race: the loser presents
// an already-consumed token, gets invalid_grant, and spuriously flags needs_reauth.
// claimTokenRefresh makes exactly one caller the refresher via an atomic DB claim; the
// loser skips the fetch and reuses a usable stored token. These tests simulate the race
// by PRE-CLAIMING the refresh slot (standing in for the sibling process) and asserting
// the loser never fetches and never flips the connection. Fetch is stubbed; runs under
// vitest.db.config.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getConnection,
  claimTokenRefresh,
  getStravaAccessToken,
  setStravaCredentials,
  setStravaTokens,
} from "@/lib/integrations/connections";

let profileId: number;
let fetchMock: ReturnType<typeof vi.fn>;

const NOW = () => Math.floor(Date.now() / 1000);

function statusOf(provider: string): string | undefined {
  return getConnection(profileId, provider)?.status;
}

// Stand in for a sibling process that has already claimed the refresh slot.
function preclaim(provider: string) {
  db.prepare(
    "UPDATE integration_connections SET refresh_claimed_at = datetime('now') WHERE profile_id = ? AND provider = ?"
  ).run(profileId, provider);
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('REFRESH-RACE')").run()
      .lastInsertRowid
  );
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setStravaCredentials(profileId, "client-id", "client-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claimTokenRefresh single-flight", () => {
  it("grants the first caller and denies a second within the 60s window", () => {
    setStravaTokens(profileId, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW() - 10,
    });
    expect(claimTokenRefresh(profileId, "strava")).toBe(true);
    expect(claimTokenRefresh(profileId, "strava")).toBe(false);
  });

  it("re-grants once the prior claim has aged past the window", () => {
    setStravaTokens(profileId, {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW() - 10,
    });
    // A claim stamped 2 minutes ago is stale — the next caller may re-claim.
    db.prepare(
      "UPDATE integration_connections SET refresh_claimed_at = datetime('now','-120 seconds') WHERE profile_id = ? AND provider = 'strava'"
    ).run(profileId);
    expect(claimTokenRefresh(profileId, "strava")).toBe(true);
  });
});

describe("getStravaAccessToken loses the refresh claim (issue #470)", () => {
  it("reuses a still-valid access token WITHOUT refreshing when a sibling holds the claim", async () => {
    // Inside the 5-min refresh margin (so the refresh branch is taken) but not yet
    // expired, so the loser can safely reuse it.
    setStravaTokens(profileId, {
      accessToken: "still-valid",
      refreshToken: "rotating",
      expiresAt: NOW() + 120,
    });
    preclaim("strava");

    const token = await getStravaAccessToken(profileId);

    expect(token).toBe("still-valid");
    expect(fetchMock).not.toHaveBeenCalled(); // never presented the rotating token
    expect(statusOf("strava")).toBe("connected"); // no spurious needs_reauth
  });

  it("skips the sync (null) rather than flagging reauth when its token is already expired", async () => {
    setStravaTokens(profileId, {
      accessToken: "expired",
      refreshToken: "rotating",
      expiresAt: NOW() - 60,
    });
    preclaim("strava");

    const token = await getStravaAccessToken(profileId);

    expect(token).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusOf("strava")).toBe("connected");
  });
});

describe("getStravaAccessToken wins the refresh claim", () => {
  it("refreshes, persists the rotated pair, and stamps the claim", async () => {
    setStravaTokens(profileId, {
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: NOW() - 60,
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_at: NOW() + 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const token = await getStravaAccessToken(profileId);

    expect(token).toBe("new-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cfg = JSON.parse(getConnection(profileId, "strava")!.config!);
    expect(cfg.accessToken).toBe("new-access");
    expect(cfg.refreshToken).toBe("new-refresh");
    // The winner stamped the claim so a concurrent caller would lose it.
    expect(claimTokenRefresh(profileId, "strava")).toBe(false);
  });
});
