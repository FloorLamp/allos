// DB INTEGRATION TIER — the ONE pull-sync runner (#2040).
//
// sync-orchestrators.test.ts pins each provider's own end-to-end behaviour and passes
// UNEDITED across this consolidation, which is the behaviour-preservation evidence.
// What it cannot show is the property the consolidation is FOR: that two different
// providers, with different credentials, different pagination and different row
// kinds, now run through the same code and still produce their own rows, their own
// counts and their own events — and that one of them failing leaves the other
// untouched.
//
// SEAM. Every provider bottoms out in global fetch; there is no injection point, so
// (like sync-orchestrators and notify-orchestrators) we stub fetch and route by URL.
// The real paging, the real transaction, the real cursor math and the real
// recordSyncEvent all run; no provider module is mocked.
//
// Every value is synthetic: fake tokens, fake credentials, obviously-fake fixtures.
// No PHI. The unix timestamps are synthetic window markers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getConnection,
  getOuraCursor,
  getWithingsCursor,
  setOuraToken,
  setWithingsCredentials,
  setWithingsTokens,
} from "@/lib/integrations/connections";
import { getLatestSyncEvent, getIntegrationSyncEvents } from "@/lib/queries";
import { pullRunners, getPullRunner } from "@/lib/integrations/pull-runners";
import { PULL_INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationSyncEvent } from "@/lib/types";

const W_TZ = "America/New_York";
const W_MEASURE_DAY = 1700000000; // synthetic unix window marker
const W_UPDATETIME = 1700100000;

// A weigh-in → one body-metrics row; a BP cuff reading → two vitals.
const W_WEIGH_IN = {
  grpid: 910001,
  date: W_MEASURE_DAY,
  category: 1,
  timezone: W_TZ,
  measures: [
    { value: 70500, type: 1, unit: -3 }, // 70.5 kg
    { value: 61, type: 11, unit: 0 }, // 61 bpm → resting HR
  ],
};
const W_BP = {
  grpid: 910002,
  date: W_MEASURE_DAY + 3600,
  category: 1,
  timezone: W_TZ,
  measures: [
    { value: 124, type: 10, unit: 0 },
    { value: 80, type: 9, unit: 0 },
  ],
};
// 1 body-metric + 2 vitals = 3 rows.
const W_EXPECTED_ROWS = 3;

const O_SLEEP = {
  id: "sleep-pull-1",
  day: "2024-06-02",
  type: "long_sleep",
  bedtime_start: "2024-06-01T23:00:00-07:00",
  bedtime_end: "2024-06-02T07:00:00-07:00",
  total_sleep_duration: 25200,
  deep_sleep_duration: 4800,
  rem_sleep_duration: 5400,
  light_sleep_duration: 13200,
  awake_time: 1800,
  average_hrv: 60,
  lowest_heart_rate: 50,
};
// sleep: total + 4 stages + hrv = 6 samples, + 1 resting-HR body metric = 7.
const O_EXPECTED_ROWS = 7;

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

interface StubOpts {
  // Fail Oura's sleep pull with this HTTP status instead of returning data.
  ouraStatus?: number;
  // Throw at the network layer for every Oura request (DNS/TLS/timeout shape).
  ouraThrows?: boolean;
}

// One stub serving BOTH providers, so a single pass exercises them together the way
// the hourly tick does.
function stubBothProviders(opts: StubOpts = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("ouraring.com")) {
        if (opts.ouraThrows) throw new Error("ECONNRESET");
        if (opts.ouraStatus)
          return new Response(null, { status: opts.ouraStatus });
        if (u.includes("/daily_sleep") || u.includes("/daily_readiness"))
          return jsonResponse({ data: [], next_token: null });
        if (u.includes("/workout"))
          return jsonResponse({ data: [], next_token: null });
        if (u.includes("/sleep"))
          return jsonResponse({ data: [O_SLEEP], next_token: null });
      }
      if (u.includes("wbsapi.withings.net")) {
        if (u.includes("/v2/oauth2"))
          throw new Error("unexpected Withings token refresh");
        if (u.includes("/v2/sleep"))
          return jsonResponse({
            status: 0,
            body: { timezone: W_TZ, series: [] },
          });
        if (u.includes("/measure"))
          return jsonResponse({
            status: 0,
            body: {
              timezone: W_TZ,
              updatetime: W_UPDATETIME,
              measuregrps: [W_WEIGH_IN, W_BP],
              more: false,
            },
          });
      }
      throw new Error(`unexpected URL: ${u}`);
    })
  );
}

// The hourly tick's loop, reproduced: iterate the registry's pull providers, run only
// the connected ones, and isolate each so one failure can't stop the next. Returns
// the ids it actually ran, in order.
async function tickLoop(profileId: number): Promise<string[]> {
  const ran: string[] = [];
  for (const runner of pullRunners()) {
    try {
      if (getConnection(profileId, runner.id)?.status !== "connected") continue;
      await runner.run(profileId);
      ran.push(runner.id);
    } catch {
      // Best-effort, exactly like the tick.
    }
  }
  return ran;
}

function rowCount(profileId: number, table: string, source: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ? AND source = ?`
      )
      .get(profileId, source) as { n: number }
  ).n;
}

function splitOf(ev: IntegrationSyncEvent) {
  return {
    ok: ev.ok,
    inserted: ev.inserted,
    updated: ev.updated,
    unchanged: ev.unchanged,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pull registry", () => {
  it("binds a runner for every provider that declares the facet", () => {
    // pullRunners() throws for a facet with no runner; calling it IS the assertion,
    // and the ids must match the registry's own list.
    expect(pullRunners().map((r) => r.id)).toEqual(
      PULL_INTEGRATIONS.map((d) => d.id)
    );
  });

  it("offers nothing for a provider allos does not pull", () => {
    // Health Connect is push-only; Fitbit Takeout is a one-off archive upload.
    expect(getPullRunner("health-connect")).toBeUndefined();
    expect(getPullRunner("fitbit-takeout")).toBeUndefined();
  });
});

describe("two providers through the one runner", () => {
  let p: number;
  beforeEach(() => {
    p = newProfile("PULL-PAIR");
    setOuraToken(p, "oura-pat");
    setWithingsCredentials(p, "w-client", "w-secret");
    setWithingsTokens(p, {
      accessToken: "w-access",
      refreshToken: "w-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it("lands each provider's own rows, counts and cursor in one pass", async () => {
    stubBothProviders();
    expect(await tickLoop(p)).toEqual(["oura", "withings"]);

    // Rows landed under their OWN source — one runner, no cross-contamination.
    expect(rowCount(p, "metric_samples", "oura")).toBe(6);
    expect(rowCount(p, "body_metrics", "oura")).toBe(1);
    expect(rowCount(p, "body_metrics", "withings")).toBe(1);
    expect(rowCount(p, "medical_records", "withings")).toBe(2);
    expect(rowCount(p, "metric_samples", "withings")).toBe(0);

    // Each provider's event carries ITS OWN split.
    expect(splitOf(getLatestSyncEvent(p, "oura")!)).toEqual({
      ok: 1,
      inserted: O_EXPECTED_ROWS,
      updated: 0,
      unchanged: 0,
    });
    expect(splitOf(getLatestSyncEvent(p, "withings")!)).toEqual({
      ok: 1,
      inserted: W_EXPECTED_ROWS,
      updated: 0,
      unchanged: 0,
    });

    // Each provider's own cursor shape advanced: a day string, and epoch seconds.
    expect(getOuraCursor(p)).toBe("2024-06-02");
    expect(getWithingsCursor(p)).toBe(W_UPDATETIME);
  });

  it("stays idempotent: a second pass re-fetches the window and writes nothing", async () => {
    stubBothProviders();
    await tickLoop(p);
    await tickLoop(p);

    // Same rows, not doubled — the dedupe-on-natural-key invariant, asserted through
    // the shared runner for both providers at once.
    expect(rowCount(p, "metric_samples", "oura")).toBe(6);
    expect(rowCount(p, "medical_records", "withings")).toBe(2);
    expect(splitOf(getLatestSyncEvent(p, "oura")!)).toEqual({
      ok: 1,
      inserted: 0,
      updated: 0,
      unchanged: O_EXPECTED_ROWS,
    });
    expect(splitOf(getLatestSyncEvent(p, "withings")!)).toEqual({
      ok: 1,
      inserted: 0,
      updated: 0,
      unchanged: W_EXPECTED_ROWS,
    });
    // Every run is recorded, quiet or not — two events per provider.
    expect(getIntegrationSyncEvents(p, "oura", 10)).toHaveLength(2);
    expect(getIntegrationSyncEvents(p, "withings", 10)).toHaveLength(2);
  });

  it("isolates a failing provider: the next one still syncs, and only the failure is logged as one", async () => {
    // A transient 500 on Oura's pull. Withings is untouched in the same pass.
    stubBothProviders({ ouraStatus: 500 });
    expect(await tickLoop(p)).toEqual(["oura", "withings"]);

    const ouraEv = getLatestSyncEvent(p, "oura")!;
    expect(ouraEv.ok).toBe(0);
    expect(String(ouraEv.error)).toContain("500");
    // A transient failure must never tear down the connection (#326).
    expect(getConnection(p, "oura")?.status).toBe("connected");
    // …and the cursor is untouched, so the next run re-fetches the whole window.
    expect(getOuraCursor(p)).toBeNull();

    expect(splitOf(getLatestSyncEvent(p, "withings")!)).toEqual({
      ok: 1,
      inserted: W_EXPECTED_ROWS,
      updated: 0,
      unchanged: 0,
    });
    expect(rowCount(p, "medical_records", "withings")).toBe(2);
  });

  it("turns a network throw into a recorded failure rather than an escaping rejection", async () => {
    // The #476 shape: a connection that opens but never responds. If this escaped,
    // the tick would lose the rest of the profile's providers and Review would stay
    // green while the source had silently stopped.
    stubBothProviders({ ouraThrows: true });
    expect(await tickLoop(p)).toEqual(["oura", "withings"]);

    const ouraEv = getLatestSyncEvent(p, "oura")!;
    expect(ouraEv.ok).toBe(0);
    expect(String(ouraEv.error)).toContain("Oura");
    expect(getLatestSyncEvent(p, "withings")!.ok).toBe(1);
  });

  it("logs nothing at all for a provider that was never connected", async () => {
    const fresh = newProfile("PULL-UNCONNECTED");
    stubBothProviders();
    expect(await tickLoop(fresh)).toEqual([]);
    expect(getLatestSyncEvent(fresh, "oura")).toBeNull();
    expect(getLatestSyncEvent(fresh, "withings")).toBeNull();
  });
});
