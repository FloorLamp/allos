// DB INTEGRATION TIER — the PULL-provider sync ORCHESTRATORS (issue #674) against a
// real (in-memory) SQLite handle. The pure mappers (withings.ts / oura.ts /
// strava.ts) + the shared normalize upserts already have coverage (withings-sync /
// oura-sync tests), and the connection-state transitions have theirs
// (connection-reauth / token-refresh-race). What was missing — withings-sync.ts was
// 0% in every tier, and the token-refresh SUCCESS / 429 / cursor-advance branches
// were thin across providers — is the gather→page→upsert→cursor→record loop the
// run*Sync functions own. This drives those end-to-end with a FAKE PROVIDER wired at
// the network seam.
//
// SEAM. Every orchestrator bottoms out in global fetch (via ouraGet / stravaGet /
// withingsPost); there is no injection point. So, exactly like notify-orchestrators
// and connection-reauth, we stub global fetch and route by URL — the real paging,
// the real envelope/HTTP status handling, the real writeTx upserts, the real cursor
// math, and the real recordSyncEvent all run. No provider module is mocked.
//
// Every value is synthetic: fake tokens, fake client credentials, obviously-fake
// measurement fixtures. No PHI. The unix timestamps are synthetic window markers,
// not identifiers of any kind.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getConnection,
  setWithingsCredentials,
  setWithingsTokens,
  getWithingsCursor,
  setStravaCredentials,
  setStravaTokens,
  getStravaCursor,
  setOuraToken,
  getOuraCursor,
} from "@/lib/integrations/connections";
import { runWithingsSync } from "@/lib/integrations/withings-sync";
import { runStravaSync } from "@/lib/integrations/strava-sync";
import { runOuraSync } from "@/lib/integrations/oura-sync";
import { getLatestSyncEvent } from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function statusOf(profileId: number, provider: string): string | undefined {
  return getConnection(profileId, provider)?.status;
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================
// Withings — the 0%-in-every-tier orchestrator (runWithingsSync)
// =====================================================================
//
// Two Withings API surfaces both POST to https://wbsapi.withings.net: /measure
// (getmeas) and /v2/sleep (getsummary), plus the OAuth refresh at /v2/oauth2. The
// measures cursor is Withings' `lastupdate`; its `updatetime` echo is the next
// cursor. Every response rides the { status, body } envelope (status 0 = success).

const W_TZ = "America/New_York";
// Synthetic unix seconds: a measure day and the server's `updatetime` echo.
const W_MEASURE_DAY = 1700000000; // 2023-11-14 (EST)
const W_UPDATETIME = 1700100000; // the server's newest updatetime → next cursor

// A morning weigh-in (weight + body fat + scale heart pulse → resting HR) → ONE
// (date, source) body-metrics row, no vitals, no samples.
const W_WEIGH_IN = {
  grpid: 900001,
  date: W_MEASURE_DAY,
  category: 1,
  timezone: W_TZ,
  measures: [
    { value: 70500, type: 1, unit: -3 }, // 70.5 kg
    { value: 185, type: 6, unit: -1 }, // 18.5 %
    { value: 61, type: 11, unit: 0 }, // 61 bpm → resting HR
  ],
};
// A BP cuff reading (systolic + diastolic) → two vitals, no body-metrics row.
const W_BP = {
  grpid: 900002,
  date: W_MEASURE_DAY + 3600,
  category: 1,
  timezone: W_TZ,
  measures: [
    { value: 124, type: 10, unit: 0 }, // systolic
    { value: 80, type: 9, unit: 0 }, // diastolic
  ],
};
// One night of sleep → total + deep/rem/light/awake = 5 samples.
const W_SLEEP = {
  id: 900003,
  timezone: W_TZ,
  startdate: 1699929000, // phi-scan-ok: synthetic unix window marker, not an NPI
  enddate: 1699957800, // phi-scan-ok: synthetic unix window marker, not an NPI
  date: "2023-11-14",
  data: {
    deepsleepduration: 4800,
    lightsleepduration: 13200,
    remsleepduration: 5400,
    wakeupduration: 1800,
  },
};

// Total rows a full push lands: 1 body-metric + 2 vitals + 5 sleep samples = 8.
const W_EXPECTED_ROWS = 8;

interface WithingsRoute {
  measure?: () => Response;
  sleep?: () => Response;
  token?: () => Response;
}

// Route a Withings POST by its URL path. Distinguishes /measure, /v2/sleep, and the
// /v2/oauth2 token endpoint. Defaults each surface to a well-formed empty envelope so
// a test only specifies the surface it cares about.
function stubWithings(routes: WithingsRoute): ReturnType<typeof vi.fn> {
  const measure =
    routes.measure ??
    (() =>
      jsonResponse({ status: 0, body: { timezone: W_TZ, measuregrps: [] } }));
  const sleep =
    routes.sleep ??
    (() => jsonResponse({ status: 0, body: { timezone: W_TZ, series: [] } }));
  const token = routes.token ?? (() => jsonResponse({ status: 0, body: {} }));
  const mock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/v2/oauth2")) return token();
    if (u.includes("/v2/sleep")) return sleep();
    if (u.includes("/measure")) return measure();
    throw new Error(`unexpected Withings URL: ${u}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A single-page measure response echoing the newest updatetime.
function withingsMeasurePage(): Response {
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

function withingsSleepPage(): Response {
  return jsonResponse({
    status: 0,
    body: { timezone: W_TZ, series: [W_SLEEP], more: false },
  });
}

describe("runWithingsSync orchestrator", () => {
  let p: number;
  beforeEach(() => {
    p = newProfile("W-ORCH");
    setWithingsCredentials(p, "w-client", "w-secret");
  });

  it("end-to-end: rows land, event records the insert split, cursor advances to updatetime, second run is all-unchanged", async () => {
    // A still-valid token so the refresh branch is skipped — this test is about the
    // data pull + cursor, not token refresh.
    setWithingsTokens(p, {
      accessToken: "w-access",
      refreshToken: "w-refresh",
      expiresAt: FUTURE(),
    });
    stubWithings({ measure: withingsMeasurePage, sleep: withingsSleepPage });

    const res = await runWithingsSync(p);
    expect(res).not.toHaveProperty("error");
    // Cursor advanced to the echoed updatetime.
    expect(getWithingsCursor(p)).toBe(W_UPDATETIME);

    // The rows actually landed.
    const bm = db
      .prepare(
        "SELECT weight_kg, resting_hr FROM body_metrics WHERE profile_id = ? AND source = 'withings'"
      )
      .get(p) as { weight_kg: number; resting_hr: number };
    expect(bm.weight_kg).toBe(70.5);
    expect(bm.resting_hr).toBe(61);
    const vitals = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND source = 'withings'"
      )
      .get(p) as { n: number };
    expect(vitals.n).toBe(2);
    const samples = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND source = 'withings'"
      )
      .get(p) as { n: number };
    expect(samples.n).toBe(5);

    // The sync event records the real insert/update/unchanged split.
    const ev = getLatestSyncEvent(p, "withings")!;
    expect(ev.ok).toBe(1);
    expect(ev.inserted).toBe(W_EXPECTED_ROWS);
    expect(ev.updated).toBe(0);
    expect(ev.unchanged).toBe(0);
    expect(ev.written).toBe(W_EXPECTED_ROWS);

    // A second identical run re-fetches the trailing window and dedups every row on
    // its natural key → all-unchanged (idempotence). The echoed updatetime equals the
    // cursor, so the cursor does not move.
    const res2 = await runWithingsSync(p);
    expect(res2).not.toHaveProperty("error");
    expect(getWithingsCursor(p)).toBe(W_UPDATETIME);
    const ev2 = getLatestSyncEvent(p, "withings")!;
    expect(ev2.ok).toBe(1);
    expect(ev2.inserted).toBe(0);
    expect(ev2.unchanged).toBe(W_EXPECTED_ROWS);
  });

  it("token refresh SUCCESS: an expired token is refreshed, the retry pulls data, and the rotated pair persists", async () => {
    // Expired access token so getWithingsAccessToken takes the refresh branch.
    setWithingsTokens(p, {
      accessToken: "w-stale",
      refreshToken: "w-old-refresh",
      expiresAt: PAST(),
    });
    const mock = stubWithings({
      measure: withingsMeasurePage,
      sleep: withingsSleepPage,
      token: () =>
        jsonResponse({
          status: 0,
          body: {
            access_token: "w-fresh-access",
            refresh_token: "w-new-refresh",
            expires_in: 10800,
            userid: "42",
          },
        }),
    });

    const res = await runWithingsSync(p);
    expect(res).not.toHaveProperty("error");

    // The rotated token pair was persisted…
    const cfg = JSON.parse(getConnection(p, "withings")!.config!);
    expect(cfg.accessToken).toBe("w-fresh-access");
    expect(cfg.refreshToken).toBe("w-new-refresh");
    // …the connection stayed connected (no spurious needs_reauth)…
    expect(statusOf(p, "withings")).toBe("connected");
    // …and the retry with the fresh token actually pulled + landed data.
    expect(getWithingsCursor(p)).toBe(W_UPDATETIME);
    const ev = getLatestSyncEvent(p, "withings")!;
    expect(ev.inserted).toBe(W_EXPECTED_ROWS);
    // The token endpoint was hit exactly once (single-flight), then measure + sleep.
    const tokenCalls = mock.mock.calls.filter((c) =>
      String(c[0]).includes("/v2/oauth2")
    );
    expect(tokenCalls.length).toBe(1);
  });

  it("rate limit (429) mid-run: partial page kept, cursor NOT advanced, next run resumes", async () => {
    setWithingsTokens(p, {
      accessToken: "w-access",
      refreshToken: "w-refresh",
      expiresAt: FUTURE(),
    });
    // Measure page 1 has more data (offset set), page 2 hits 429 → the run keeps the
    // first page's items but truncates and does NOT advance the cursor.
    const measure = vi.fn((): Response => {
      // The mock's own invocation is already recorded, so calls.length === 1 on the
      // first page fetch.
      if (measure.mock.calls.length === 1) {
        return jsonResponse({
          status: 0,
          body: {
            timezone: W_TZ,
            updatetime: W_UPDATETIME,
            measuregrps: [W_WEIGH_IN],
            more: true,
            offset: 1,
          },
        });
      }
      return new Response(null, { status: 429 });
    });
    stubWithings({ measure, sleep: withingsSleepPage });

    const before = getWithingsCursor(p);
    const res = await runWithingsSync(p);
    // A truncated run still returns a summary (not an error) and flags truncated.
    expect(res).not.toHaveProperty("error");
    expect((res as { truncated?: boolean }).truncated).toBe(true);
    // The first page's weigh-in still landed…
    const bm = db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND source = 'withings'"
      )
      .get(p) as { n: number };
    expect(bm.n).toBe(1);
    // …but the cursor was NOT advanced past the rate-limited page, so the next run
    // re-fetches the whole window rather than stranding un-synced measurements.
    expect(getWithingsCursor(p)).toBe(before);
    expect(getWithingsCursor(p)).toBe(0);
  });

  it("the user-edit lock holds through the full orchestrator (#133)", async () => {
    setWithingsTokens(p, {
      accessToken: "w-access",
      refreshToken: "w-refresh",
      expiresAt: FUTURE(),
    });
    stubWithings({ measure: withingsMeasurePage, sleep: withingsSleepPage });
    await runWithingsSync(p);
    // Hand-correct the imported weigh-in and set the edit lock, as the app's edit path
    // would.
    db.prepare(
      "UPDATE body_metrics SET edited = 1, weight_kg = 71.9 WHERE profile_id = ? AND source = 'withings'"
    ).run(p);

    // A second push must skip the locked row (counted `edited`), not clobber it.
    await runWithingsSync(p);
    const ev = getLatestSyncEvent(p, "withings")!;
    expect(ev.edited).toBe(1);
    const bm = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND source = 'withings'"
      )
      .get(p) as { weight_kg: number };
    expect(bm.weight_kg).toBe(71.9);
  });
});

// =====================================================================
// Strava — per-activity detail fetch + rate-limit truncation (runStravaSync)
// =====================================================================
//
// Strava pages GET /athlete/activities (list) oldest-first via `after`, then GETs
// /activities/{id} per activity for calories. The cursor is the newest activity
// start (epoch seconds). integration-sync-events already covers the network-throw
// path; the happy list+detail loop, the cursor advance, and the 429 truncation are
// covered here.

const STRAVA_ACT_1 = {
  id: 111,
  name: "Morning Ride",
  sport_type: "Ride",
  type: "Ride",
  start_date: "2024-06-01T13:00:00Z",
  start_date_local: "2024-06-01T06:00:00Z",
  moving_time: 3600,
  elapsed_time: 3700,
  distance: 24000,
};
const STRAVA_ACT_2 = {
  id: 222,
  name: "Evening Run",
  sport_type: "Run",
  type: "Run",
  start_date: "2024-06-02T01:00:00Z", // strictly newer than ACT_1
  start_date_local: "2024-06-01T18:00:00Z",
  moving_time: 1800,
  elapsed_time: 1850,
  distance: 5000,
};
const STRAVA_DETAIL: Record<number, Record<string, unknown>> = {
  111: { ...STRAVA_ACT_1, calories: 600 },
  222: { ...STRAVA_ACT_2, calories: 300 },
};
const startSec = (a: { start_date: string }) =>
  Math.floor(Date.parse(a.start_date) / 1000);

interface StravaOpts {
  // Return 429 on the detail fetch for these activity ids (simulate a mid-run limit).
  detail429?: number[];
  // Capture the `after` query param seen on each list request.
  afters?: number[];
}

function stubStrava(opts: StravaOpts = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      // No refresh expected in these tests (valid token seeded); fail loudly if hit.
      throw new Error("unexpected Strava token refresh");
    }
    if (u.includes("/athlete/activities")) {
      const after = Number(new URL(u).searchParams.get("after"));
      opts.afters?.push(after);
      const page = Number(new URL(u).searchParams.get("page"));
      // Page 1 returns both summaries (a short page < per_page ends paging); later
      // pages are empty.
      return jsonResponse(page === 1 ? [STRAVA_ACT_1, STRAVA_ACT_2] : []);
    }
    if (u.includes("/activities/")) {
      const id = Number(u.split("/activities/")[1].split("?")[0]);
      if (opts.detail429?.includes(id))
        return new Response(null, { status: 429 });
      return jsonResponse(STRAVA_DETAIL[id]);
    }
    throw new Error(`unexpected Strava URL: ${u}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("runStravaSync orchestrator", () => {
  let p: number;
  beforeEach(() => {
    p = newProfile("S-ORCH");
    setStravaCredentials(p, "s-client", "s-secret");
    setStravaTokens(p, {
      accessToken: "s-access",
      refreshToken: "s-refresh",
      expiresAt: FUTURE(), // valid → no refresh, no /oauth/token hit
    });
  });

  it("end-to-end: list + per-activity detail land activities, cursor advances to the newest start, second run is all-unchanged over the trailing window", async () => {
    const afters: number[] = [];
    stubStrava({ afters });

    const res = await runStravaSync(p);
    expect(res).not.toHaveProperty("error");
    // Both activities landed with their calorie samples (2 acts + 2 samples).
    const acts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE profile_id = ? AND source = 'strava'"
      )
      .get(p) as { n: number };
    expect(acts.n).toBe(2);
    const samples = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND source = 'strava'"
      )
      .get(p) as { n: number };
    expect(samples.n).toBe(2);
    // Cursor advanced to the NEWEST activity's start.
    expect(getStravaCursor(p)).toBe(startSec(STRAVA_ACT_2));
    // The event records the insert split (2 acts + 2 kcal samples = 4).
    const ev = getLatestSyncEvent(p, "strava")!;
    expect(ev.ok).toBe(1);
    expect(ev.inserted).toBe(4);

    // First run paged from after=0 (no cursor yet).
    expect(afters[0]).toBe(0);

    // Second run: the cursor rewinds by the 7-day trailing re-scan margin, so late
    // uploads aren't skipped, and every re-fetched row dedups → all-unchanged.
    const res2 = await runStravaSync(p);
    expect(res2).not.toHaveProperty("error");
    const RESCAN = 7 * 24 * 60 * 60;
    expect(afters[afters.length - 1]).toBe(startSec(STRAVA_ACT_2) - RESCAN);
    const ev2 = getLatestSyncEvent(p, "strava")!;
    expect(ev2.inserted).toBe(0);
    expect(ev2.unchanged).toBe(4);
  });

  it("rate limit (429) on a mid-run detail fetch: the run truncates, and the cursor stops at the last fully-imported activity", async () => {
    // ACT_1's detail succeeds; ACT_2's detail 429s. ACT_2 must NOT be imported (it
    // would land calorie-less and strand the cursor past it), and the cursor must stop
    // at ACT_1 so the next run resumes and imports ACT_2 with calories.
    stubStrava({ detail429: [222] });

    const res = await runStravaSync(p);
    expect(res).not.toHaveProperty("error");
    expect((res as { truncated?: boolean }).truncated).toBe(true);
    // Only ACT_1 landed.
    const rows = db
      .prepare(
        "SELECT external_id FROM activities WHERE profile_id = ? AND source = 'strava' ORDER BY external_id"
      )
      .all(p) as { external_id: string }[];
    expect(rows.map((r) => r.external_id)).toEqual(["strava:111"]);
    // Cursor stopped at ACT_1 — strictly before ACT_2's start.
    expect(getStravaCursor(p)).toBe(startSec(STRAVA_ACT_1));
    expect(getStravaCursor(p)).toBeLessThan(startSec(STRAVA_ACT_2));
  });
});

// =====================================================================
// Oura — trailing re-scan window + 429 truncation (runOuraSync)
// =====================================================================
//
// Oura pages GET /v2/usercollection/sleep and /workout over a start_date/end_date
// window. The token is a pasted PAT (no OAuth refresh). connection-reauth already
// covers the revoked-PAT (401 → needs_reauth) and transient-500 pull paths; the
// happy pull, the cursor advance to the newest day, the trailing re-scan window on
// the next run, and 429 truncation are covered here.

const OURA_SLEEP = {
  id: "sleep-orch-1",
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
const OURA_WORKOUT = {
  id: "workout-orch-1",
  activity: "cycling",
  day: "2024-06-02",
  calories: 520,
  distance: 24000,
  start_datetime: "2024-06-02T18:00:00-07:00",
  end_datetime: "2024-06-02T19:00:00-07:00",
  intensity: "hard",
  label: null,
};
// sleep: total + 4 stages + hrv = 6 samples, + 1 rhr body-metric.
// workout: 1 activity + 1 kcal sample. Total inserted = 9.
const OURA_EXPECTED_ROWS = 9;

interface OuraOpts {
  workout429?: boolean;
  starts?: string[]; // captured start_date query params (sleep + workout)
}

function stubOura(opts: OuraOpts = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: unknown) => {
    const u = String(url);
    const start = new URL(u).searchParams.get("start_date");
    if (start) opts.starts?.push(start);
    // Vendor daily-score endpoints (issue #1069). Checked first and matched
    // exactly so they never fall through to the looser /sleep branch. Return an
    // empty page: this orchestrator test pins the sleep+workout row counts, and
    // the score ingestion is covered by oura-sync.test.ts.
    if (u.includes("/daily_sleep") || u.includes("/daily_readiness")) {
      return jsonResponse({ data: [], next_token: null });
    }
    if (u.includes("/workout")) {
      if (opts.workout429) return new Response(null, { status: 429 });
      return jsonResponse({ data: [OURA_WORKOUT], next_token: null });
    }
    if (u.includes("/sleep")) {
      return jsonResponse({ data: [OURA_SLEEP], next_token: null });
    }
    throw new Error(`unexpected Oura URL: ${u}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("runOuraSync orchestrator", () => {
  let p: number;
  beforeEach(() => {
    p = newProfile("O-ORCH");
    setOuraToken(p, "oura-pat");
  });

  it("end-to-end: sleep + workout land, cursor advances to the newest day, second run re-scans the trailing window and dedups", async () => {
    const starts: string[] = [];
    stubOura({ starts });

    const res = await runOuraSync(p);
    expect(res).not.toHaveProperty("error");
    // The workout activity + rhr body-metric landed.
    const acts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE profile_id = ? AND source = 'oura'"
      )
      .get(p) as { n: number };
    expect(acts.n).toBe(1);
    const rhr = db
      .prepare(
        "SELECT resting_hr FROM body_metrics WHERE profile_id = ? AND source = 'oura' AND date = '2024-06-02'"
      )
      .get(p) as { resting_hr: number };
    expect(rhr.resting_hr).toBe(50);
    // Cursor advanced to the newest fully-processed day.
    expect(getOuraCursor(p)).toBe("2024-06-02");
    const ev = getLatestSyncEvent(p, "oura")!;
    expect(ev.ok).toBe(1);
    expect(ev.inserted).toBe(OURA_EXPECTED_ROWS);

    // Second run: start_date rewinds 3 days before the cursor (RESCAN_DAYS) so a
    // late-finalized night isn't skipped, and the re-fetched rows all dedup.
    const res2 = await runOuraSync(p);
    expect(res2).not.toHaveProperty("error");
    // 2024-06-02 minus 3 days = 2024-05-30.
    expect(starts[starts.length - 1]).toBe("2024-05-30");
    const ev2 = getLatestSyncEvent(p, "oura")!;
    expect(ev2.inserted).toBe(0);
    expect(ev2.unchanged).toBe(OURA_EXPECTED_ROWS);
  });

  it("rate limit (429) mid-run: the sleep page lands, the workout page truncates, and the cursor is NOT advanced", async () => {
    stubOura({ workout429: true });

    const res = await runOuraSync(p);
    // A 429 truncates the run gracefully (summary, not error).
    expect(res).not.toHaveProperty("error");
    expect((res as { truncated?: boolean }).truncated).toBe(true);
    // Sleep rows still landed…
    const samples = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND source = 'oura'"
      )
      .get(p) as { n: number };
    expect(samples.n).toBe(6); // total + 4 stages + hrv
    // …no workout landed…
    const acts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE profile_id = ? AND source = 'oura'"
      )
      .get(p) as { n: number };
    expect(acts.n).toBe(0);
    // …and the cursor was NOT advanced, so the next run re-fetches the whole window.
    expect(getOuraCursor(p)).toBeNull();
    // A transient 429 must never flip the connection out of connected.
    expect(statusOf(p, "oura")).toBe("connected");
  });
});
