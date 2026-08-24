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
import { runStravaSync } from "@/lib/integrations/strava-sync";
import { runWithingsSync } from "@/lib/integrations/withings-sync";
import { getLatestSyncEvent } from "@/lib/queries";

let profileId: number;
let fetchMock: ReturnType<typeof vi.fn>;

function statusOf(provider: string): string | undefined {
  return getConnection(profileId, provider)?.status;
}

// What the integration card, the "Sync now" toast and the digest all read.
function latestError(provider: string): string | null | undefined {
  return getLatestSyncEvent(profileId, provider)?.error;
}

// A past expiry so getStrava/WithingsAccessToken always take the refresh branch.
const EXPIRED = Math.floor(Date.now() / 1000) - 3600;
// A live one, so a run reaches the DATA PULL instead of stopping at the refresh.
const LIVE = Math.floor(Date.now() / 1000) + 3600;

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

  // ---- THE DATA-PULL 400, AND THE STATE MACHINE IT MOVES (#3618 review) ------
  //
  // A DELIBERATE CHANGE TO #326's TRANSITION SET, pinned here because it is one.
  // Before this, `pull-sync` asked the REFRESH question (isAuthRefreshFailure) of a
  // DATA-PULL status, and that rule answers true for a bodyless 400 — correct when
  // a token endpoint rejects a grant, and meaningless when a data endpoint rejects
  // a window. So an ordinary parameter-validation 400 from Oura's data API flipped a
  // healthy connection to `needs_reauth`, which stops the hourly tick syncing the
  // source at all, escalates past the digest's silence tolerance, and — once #3618
  // gave the exit a sentence — told the person their connection had expired.
  //
  // Oura's real revoked-PAT case is the 401 above and is untouched. Nothing else in
  // the definitive set moves: the REFRESH paths still read the refresh rule, body
  // and all (see the Strava and Withings blocks above, which pin that).
  it("a data-pull 400 does NOT flip the connection, and does not say reconnect", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "end_date is out of the allowed range",
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );
    const res = await runOuraSync(profileId);

    expect(res).toHaveProperty("error");
    // The state: still connected, so the tick keeps trying and the source keeps
    // syncing the moment the request is fixed.
    expect(statusOf("oura")).toBe("connected");
    // The sentence: a rejected request, offering no advice it cannot honour — and
    // above all not the reconnect ask, which would be false.
    expect(res).toEqual({ error: "Couldn't sync your Oura data." });
    expect(String(latestError("oura"))).not.toContain("Reconnect");
    expect(String(latestError("oura"))).not.toContain("expired");
  });
});

// ---- THE OTHER TWO PRODUCERS OF THE SAME LINE (#3618 review) ----------------
//
// Oura and weather each had a test that reads the sentence off a real run. Strava
// and Withings did not, at any tier — their new copy was carried by comments alone,
// so `listRes.error ?? ""`, `res.error ?? ""`, or a revert to the old
// `… request failed (${status})` string all passed every suite. These run the real
// runner against a stubbed host and read the recorded event, which is the same
// string the card, the toast and the digest render.
describe("Strava's failing-status line is house copy (#3618)", () => {
  beforeEach(() => {
    setStravaCredentials(profileId, "client-id", "client-secret");
    // A LIVE token, so the run reaches the activity-list pull rather than stopping
    // at the refresh — this is the data-pull door, not the refresh one.
    setStravaTokens(profileId, {
      accessToken: "live-access",
      refreshToken: "live-refresh",
      expiresAt: LIVE,
    });
  });

  it("a 503 on the activity list names Strava and offers the retry", async () => {
    fetchMock.mockResolvedValue(new Response("upstream", { status: 503 }));
    const res = await runStravaSync(profileId);

    expect(res).toEqual({ error: "Couldn't reach Strava. Try again." });
    expect(latestError("strava")).toBe("Couldn't reach Strava. Try again.");
    // The class #3618 closed: no path, no status, no digits at all.
    expect(String(latestError("strava"))).not.toMatch(/\d/);
    expect(String(latestError("strava"))).not.toContain("/athlete/activities");
    // A pull failure is not an auth failure.
    expect(statusOf("strava")).toBe("connected");
  });

  it("a 404 offers no retry it cannot honour, and is still a whole sentence", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await runStravaSync(profileId);

    expect(res).toEqual({ error: "Couldn't sync your Strava activities." });
    expect(String(latestError("strava"))).not.toContain("Try again");
    expect(String(latestError("strava"))).not.toMatch(/\d/);
  });
});

describe("Withings' failing-status line is house copy, in both its dialects (#3618)", () => {
  beforeEach(() => {
    setWithingsCredentials(profileId, "w-client", "w-secret");
    setWithingsTokens(profileId, {
      accessToken: "live-access",
      refreshToken: "live-refresh",
      expiresAt: LIVE,
    });
  });

  it("an HTTP 503 names Withings — that one really is a failure to reach them", async () => {
    fetchMock.mockResolvedValue(new Response("upstream", { status: 503 }));
    const res = await runWithingsSync(profileId);

    expect(res).toEqual({ error: "Couldn't reach Withings. Try again." });
    expect(latestError("withings")).toBe("Couldn't reach Withings. Try again.");
    expect(String(latestError("withings"))).not.toMatch(/\d/);
    expect(String(latestError("withings"))).not.toContain("/measure");
  });

  it("an envelope code rode a 200, so it must NOT claim we couldn't reach them", async () => {
    // 2555 is Withings' "an unknown error occurred, try again" — served with HTTP
    // 200 and the code in the payload. The retry advice is right; "Couldn't reach
    // Withings." would be false, because they answered.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 2555 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await runWithingsSync(profileId);

    expect(res).toEqual({
      error: "Couldn't sync your Withings data. Try again.",
    });
    expect(String(latestError("withings"))).not.toContain("reach");
    expect(String(latestError("withings"))).not.toMatch(/\d/);
    expect(statusOf("withings")).toBe("connected");
  });

  it("an envelope with no status at all offers the retry rather than none", async () => {
    // JSON that parses but carries no numeric `status` — withingsPost marks that -1.
    // Nobody refused us anything, so the advice must be to try again; the sentinel
    // being NEGATIVE is what keeps it out of the no-advice family (a positive
    // placeholder would have been read as a 4xx-shaped refusal).
    //
    // NOT the gateway-HTML case, which never reaches -1: an unparseable body throws
    // inside withingsPost and takes the network-throw branch instead. See the open
    // question recorded at that branch.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ body: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await runWithingsSync(profileId);

    expect(res).toEqual({
      error: "Couldn't sync your Withings data. Try again.",
    });
    expect(statusOf("withings")).toBe("connected");
  });
});

// ---- The SENTENCE and the STATE are one decision (#3618) --------------------
//
// A broken sync used to tell a person the HTTP path and the status — "Oura
// /v2/usercollection/sleep request failed (401)" — on the integration card, in the
// "Sync now" toast and in the morning digest. An expired token is the single most
// common thing behind that line, and the one thing a person can actually do about it
// is reconnect.
//
// THE INVARIANT THESE CASES PIN is not "a 401 says reconnect". It is that the
// sentence and `needs_reauth` are chosen by the SAME failure exit in
// lib/integrations/pull-sync.ts, which reads the connection's own recorded state.
// That matters because `needs_reauth` is what every reconnect affordance keys on —
// the notice on each source page, and ConnectedSources' "Reconnect <name> →" link —
// so a card that says reconnect is a card that has the control beside it, and a
// transient failure can never say it.
//
// Both doors into that state are driven here, because a status test at either one
// alone would see half of it: a revoked Oura personal access token arrives as a 401
// on the DATA PULL, and a dead Strava refresh token is caught by the REFRESH PATH,
// which marks the connection and throws before any pull happens.
describe("the recorded failure line agrees with the connection state (#3618)", () => {
  // The REGISTRY's display name — what the person sees on the card and in the nav —
  // not the vendor token the fetch layer names ("Couldn't reach Oura."). The two
  // differ for this source and the runner is the surface that should say "Oura Ring".
  const RECONNECT =
    "Your Oura Ring connection expired. Reconnect to resume syncing.";

  beforeEach(() => {
    setOuraToken(profileId, "dead-token");
  });

  it("a revoked PAT says reconnect, and names no path or status", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const res = await runOuraSync(profileId);

    expect(statusOf("oura")).toBe("needs_reauth");
    expect(res).toEqual({ error: RECONNECT });
    // The class this closes: no HTTP path, no status code, no digits at all.
    expect(RECONNECT).not.toMatch(/\d/);
    expect(RECONNECT).not.toContain("/v2/");
    // And the SAME string is what the card, the toast and the digest read, because
    // all three render the recorded event.
    expect(latestError("oura")).toBe(RECONNECT);
  });

  it("a transient 500 never says reconnect — the connection is still connected", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream error", { status: 500 })
    );
    const res = await runOuraSync(profileId);

    expect(statusOf("oura")).toBe("connected");
    expect(res).toEqual({ error: "Couldn't reach Oura. Try again." });
    expect(latestError("oura")).not.toContain("Reconnect");
    expect(String(latestError("oura"))).not.toMatch(/\d/);
  });

  it("a rejected request says neither reconnect nor try again", async () => {
    // A 404 is deterministic and is nobody's to retry, so the sentence offers no
    // advice rather than advice that cannot work.
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await runOuraSync(profileId);

    expect(statusOf("oura")).toBe("connected");
    expect(res).toEqual({ error: "Couldn't sync your Oura data." });
    expect(String(latestError("oura"))).not.toMatch(/\d/);
  });

  it("a dead refresh token says reconnect too — the other door into the state", async () => {
    setStravaCredentials(profileId, "client-id", "client-secret");
    setStravaTokens(profileId, {
      accessToken: "dead-access",
      refreshToken: "dead-refresh",
      expiresAt: EXPIRED,
    });
    fetchMock.mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    );
    const res = await runStravaSync(profileId);

    expect(statusOf("strava")).toBe("needs_reauth");
    // Without the runner reading the state, this reads "Couldn't connect to Strava."
    // — the classifier's answer for a throw it cannot place, and a sentence with no
    // next step in it.
    expect(res).toEqual({
      error: "Your Strava connection expired. Reconnect to resume syncing.",
    });
  });
});
