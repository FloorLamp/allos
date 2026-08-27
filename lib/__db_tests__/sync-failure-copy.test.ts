// DB INTEGRATION TIER — what `integration_sync_events.error` SAYS when a sync
// breaks (#3618).
//
// That column is the whole of what a person is told: the integration card renders
// it in red, "Sync now" shows it as the toast, and the morning digest quotes it as
// the item's `because`. Until this change it carried the wire — `Oura
// /v2/usercollection/sleep request failed (401)`, `weather fetch failed (503)` —
// which names a path and a number and asks for nothing.
//
// The table below is the reachability proof for every one of those sentences: each
// row runs a REAL runner against a stubbed network and reads back the row the
// runner actually wrote. On origin/main every `expected` here is the jargon
// instead, so each row reds there and greens on this branch.
//
// SEAM. Every provider bottoms out in global fetch; there is no injection point, so
// (like sync-orchestrators and pull-runner) we stub fetch and route by URL. The real
// paging, the real envelope handling, the real reauth transition and the real
// recordSyncEvent all run; no provider module is mocked.
//
// Every value is synthetic: fake tokens, fake client credentials, a fake home
// location. No PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { setHomeLocation } from "@/lib/settings";
import {
  getConnection,
  setOuraToken,
  setStravaCredentials,
  setStravaTokens,
  setWithingsCredentials,
  setWithingsTokens,
} from "@/lib/integrations/connections";
import { resetStravaRateLimitState } from "@/lib/integrations/strava-rate-limit";
import { runOuraSync } from "@/lib/integrations/oura-sync";
import { runStravaSync } from "@/lib/integrations/strava-sync";
import { runWithingsSync } from "@/lib/integrations/withings-sync";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import { getLatestSyncEvent } from "@/lib/queries";

type SourceId = "oura" | "withings" | "strava" | "weather";

// WHERE the failure arrives, because the three places answer differently:
//   http     — a non-OK HTTP status on the DATA request.
//   envelope — Withings' own dialect: HTTP 200 carrying { status: <code> }.
//   refresh  — the token refresh itself was rejected. This is where an EXPIRED
//              grant actually shows up for Strava and Withings, and it is the most
//              common sync failure a person meets.
type Arrival = "http" | "envelope" | "refresh";

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function envelope(status: number): Response {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Connect the source with credentials that force the arrival under test: a refresh
// case needs an EXPIRED access token so the refresh is actually attempted.
function connect(p: number, source: SourceId, arrival: Arrival): void {
  const expiresAt = arrival === "refresh" ? PAST() : FUTURE();
  if (source === "oura") setOuraToken(p, "oura-pat");
  if (source === "strava") {
    setStravaCredentials(p, "s-client", "s-secret");
    setStravaTokens(p, {
      accessToken: "s-access",
      refreshToken: "s-refresh",
      expiresAt,
    });
  }
  if (source === "withings") {
    setWithingsCredentials(p, "w-client", "w-secret");
    setWithingsTokens(p, {
      accessToken: "w-access",
      refreshToken: "w-refresh",
      expiresAt,
    });
  }
  if (source === "weather") setHomeLocation(p, { lat: 40.7, lng: -74 });
}

// One stub per case: every request the run makes answers with the failure under
// test, so the assertion is about the FIRST failure either way. Withings is the one
// source that rides an error in its `{ status }` envelope over HTTP 200 — both its
// refresh and its data endpoints do — and the runner reading that envelope rather
// than the HTTP status is part of what these rows exercise.
function stubNetwork(
  source: SourceId,
  arrival: Arrival,
  status: number
): void {
  const inEnvelope =
    source === "withings" && (arrival === "envelope" || arrival === "refresh");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      inEnvelope ? envelope(status) : new Response(null, { status })
    )
  );
}

function run(p: number, source: SourceId): Promise<unknown> {
  if (source === "oura") return runOuraSync(p);
  if (source === "strava") return runStravaSync(p);
  if (source === "withings") return runWithingsSync(p);
  return runWeatherSync(p);
}

interface Case {
  source: SourceId;
  arrival: Arrival;
  status: number;
  expected: string;
  // Did this failure leave the connection asking to be reconnected? Only a
  // definitive auth failure may, and the sentence must agree with the state.
  reauth: boolean;
}

const CASES: Case[] = [
  // A dead grant is a DOOR: the card's Reconnect link, the digest's Reconnect
  // action and this sentence all point at the same place.
  {
    source: "oura",
    arrival: "http",
    status: 401,
    expected: "Reconnect Oura to resume syncing.",
    reauth: true,
  },
  {
    source: "strava",
    arrival: "refresh",
    status: 401,
    expected: "Reconnect Strava to resume syncing.",
    reauth: true,
  },
  {
    source: "withings",
    arrival: "refresh",
    status: 401,
    expected: "Reconnect Withings to resume syncing.",
    reauth: true,
  },
  {
    source: "withings",
    arrival: "envelope",
    status: 401,
    expected: "Reconnect Withings to resume syncing.",
    // The PULL path reports no status to the runner on purpose — the refresh path
    // owns the transition — so the standing stays `failing`. The card escalates on
    // both, so the Reconnect affordance is reachable either way.
    reauth: false,
  },
  // A source having a bad day is nothing of the person's to fix.
  {
    source: "oura",
    arrival: "http",
    status: 500,
    expected: "Oura is having trouble. The next sync will pick it up.",
    reauth: false,
  },
  {
    source: "strava",
    arrival: "http",
    status: 502,
    expected: "Strava is having trouble. The next sync will pick it up.",
    reauth: false,
  },
  {
    source: "withings",
    arrival: "http",
    status: 503,
    expected: "Withings is having trouble. The next sync will pick it up.",
    reauth: false,
  },
  {
    source: "weather",
    arrival: "http",
    status: 503,
    expected: "Open-Meteo is having trouble. The next sync will pick it up.",
    reauth: false,
  },
  // Anything else: say it failed, and offer no retry a retry cannot honour.
  {
    source: "oura",
    arrival: "http",
    status: 403,
    expected: "Couldn't sync Oura.",
    reauth: false,
  },
  {
    source: "withings",
    arrival: "envelope",
    status: 2555,
    expected: "Couldn't sync Withings.",
    reauth: false,
  },
  // A KEYLESS source has no grant, so its bare 400 — which the shared auth
  // predicate reads as a rejected grant, correctly, for the refresh path it was
  // written for — must never send a person hunting for a connect button (#3007's
  // out-of-range window is exactly this status).
  {
    source: "weather",
    arrival: "http",
    status: 400,
    expected: "Couldn't sync Open-Meteo.",
    reauth: false,
  },
];

describe("what a broken sync tells a person (#3618)", () => {
  beforeEach(() => {
    resetStravaRateLimitState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CASES)(
    "$source $arrival $status → $expected",
    async ({ source, arrival, status, expected, reauth }) => {
      const p = newProfile(`FAILCOPY-${source}-${arrival}-${status}`);
      connect(p, source, arrival);
      stubNetwork(source, arrival, status);

      await run(p, source);

      const ev = getLatestSyncEvent(p, source)!;
      expect(ev.ok).toBe(0);
      expect(ev.error).toBe(expected);
      // The diagnostic left for the log, not the reader: no HTTP path, no status
      // code, no vendor error number anywhere in the sentence.
      expect(ev.error).not.toMatch(/\d|\//);
      expect(getConnection(p, source)?.status === "needs_reauth").toBe(reauth);
    }
  );
});
