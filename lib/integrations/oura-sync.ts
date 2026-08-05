import {
  OURA_ID,
  getOuraToken,
  getOuraCursor,
  setOuraCursor,
} from "./connections";
import {
  mapOuraSleep,
  mapOuraWorkout,
  mapOuraDailyScore,
  OURA_SLEEP_SCORE_METRIC,
  OURA_READINESS_SCORE_METRIC,
} from "./oura";
import { pullPaging } from "./registry";
import { pageOutcome, pullDayWindow } from "./pull-window";
import { runPullSync, type PullOutcome, type PullSpec } from "./pull-sync";
import type {
  NormActivity,
  NormBodyMetric,
  NormMetricSample,
} from "./normalize";

// Oura's half of the shared pull runner (#2040): the API v2 endpoints, `next_token`
// pagination, and row mapping. Everything either side of that — the timeout and page
// bounds, the 429 → truncate-and-keep-cursor rule, the transaction, the cursor
// decision, and the sync-event accounting — belongs to lib/integrations/pull-sync.ts
// and lib/integrations/pull-window.ts, which the other pull providers share.
//
// This file used to carry its own copy of all of it, and said so in a comment
// ("Mirrors strava-sync.ts"); withings-sync.ts said the same about this file.

const BASE = "https://api.ouraring.com";
const { timeoutMs, maxPages, rescanDays, backfillDays } = pullPaging(OURA_ID);

export interface OuraSyncResult {
  workouts: number;
  bodyMetrics: number;
  samples: number;
  skipped: number;
  truncated?: true;
}

export interface OuraPersonalInfo {
  id?: string;
  email?: string;
}

type OuraGet =
  { ok: true; json: unknown } | { ok: false; status: number; error?: string };

async function ouraGet(path: string, token: string): Promise<OuraGet> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (err) {
    // Network error / timeout / DNS: surface as a non-HTTP failure (status 0) so the
    // runner records a failed sync event and returns gracefully instead of throwing.
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Validate a pasted personal access token with the Oura v2 whoami. Returns the
// captured identity on success, or the HTTP status on failure (401 = bad token).
export async function validateOuraToken(
  token: string
): Promise<
  { ok: true; info: OuraPersonalInfo } | { ok: false; status: number }
> {
  const res = await ouraGet("/v2/usercollection/personal_info", token);
  if (!res.ok) return { ok: false, status: res.status };
  const j = (res.json ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    info: {
      id: typeof j.id === "string" ? j.id : undefined,
      email: typeof j.email === "string" ? j.email : undefined,
    },
  };
}

interface PageResult {
  items: Record<string, unknown>[];
  truncated: boolean;
  error?: string;
  // HTTP status of the failing request (issue #326): a 401 on a data pull means the
  // personal access token was revoked, so the runner marks the connection
  // needs_reauth. Absent on success or a network error (status 0).
  status?: number;
}

// Follow Oura's next_token pagination over a date range, accumulating `data` items.
// A rate limit truncates (partial items kept, cursor held); any other non-OK status
// returns an error. A still-present next_token at the page cap also truncates.
async function fetchPages(
  path: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<PageResult> {
  const items: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });
    if (nextToken) qs.set("next_token", nextToken);
    const res = await ouraGet(`${path}?${qs.toString()}`, token);
    if (!res.ok) {
      if (pageOutcome(res.status) === "truncate")
        return { items, truncated: true };
      return {
        items,
        truncated: false,
        error: `Oura ${path} request failed (${res.status})`,
        status: res.status,
      };
    }
    const body = (res.json ?? {}) as { data?: unknown; next_token?: unknown };
    if (Array.isArray(body.data)) {
      for (const d of body.data)
        if (d && typeof d === "object")
          items.push(d as Record<string, unknown>);
    }
    if (typeof body.next_token === "string" && body.next_token) {
      nextToken = body.next_token;
    } else {
      return { items, truncated: false };
    }
  }
  // Hit the page cap with more to fetch — keep the cursor and resume next run.
  return { items, truncated: true };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Oura's own 0–100 scores (issue #1069), ingested as DISPLAY-ONLY, engine-inert
// vendor numbers (never a synthesis input — see oura.ts / the reverse-allowlist
// guard). Same rolling window and same failure handling as the pulls above; each
// `{day, score}` maps to one idempotent per-day metric_sample.
const SCORE_ENDPOINTS: [string, string][] = [
  ["/v2/usercollection/daily_sleep", OURA_SLEEP_SCORE_METRIC],
  ["/v2/usercollection/daily_readiness", OURA_READINESS_SCORE_METRIC],
];

const ouraSpec: PullSpec<string, string, Omit<OuraSyncResult, "truncated">> = {
  id: OURA_ID,
  authorize: (profileId) => getOuraToken(profileId),
  cursor: {
    // "" rather than null so the one shared cursor comparison works on a first run.
    read: (profileId) => getOuraCursor(profileId) ?? "",
    write: setOuraCursor,
    policy: "hold-on-truncate",
  },
  summarize: (t) => ({
    workouts: t.activities,
    bodyMetrics: t.bodyMetrics,
    samples: t.samples,
    skipped: t.skipped,
  }),

  async gather(_profileId, token, cursor): Promise<PullOutcome<string>> {
    // Page from a trailing window before the cursor so late-finalized nights/workouts
    // aren't skipped; end a day past today to cover ring-vs-server timezone slack.
    const { startDate, endDate } = pullDayWindow(
      cursor || null,
      todayUtc(),
      rescanDays,
      backfillDays
    );

    const activities: NormActivity[] = [];
    const bodyMetrics: NormBodyMetric[] = [];
    const samples: NormMetricSample[] = [];
    const raw: unknown[] = [];
    let skipped = 0;
    let truncated = false;
    let newestDay = cursor;

    const bumpDay = (d: unknown) => {
      if (typeof d === "string" && d > newestDay) newestDay = d;
    };

    // ---- sleep ----
    const sleep = await fetchPages(
      "/v2/usercollection/sleep",
      token,
      startDate,
      endDate
    );
    if (sleep.error) return { error: sleep.error, status: sleep.status };
    if (sleep.truncated) truncated = true;
    for (const s of sleep.items) {
      raw.push(s);
      const mapped = mapOuraSleep(s);
      if (!mapped) {
        skipped++;
        continue;
      }
      samples.push(...mapped.samples);
      if (mapped.bodyMetric) bodyMetrics.push(mapped.bodyMetric);
      bumpDay(s.day);
    }

    // ---- workouts ----
    const workouts = await fetchPages(
      "/v2/usercollection/workout",
      token,
      startDate,
      endDate
    );
    if (workouts.error)
      return { error: workouts.error, status: workouts.status };
    if (workouts.truncated) truncated = true;
    for (const w of workouts.items) {
      raw.push(w);
      const mapped = mapOuraWorkout(w);
      if (!mapped) {
        skipped++;
        continue;
      }
      activities.push(mapped.activity);
      samples.push(...mapped.samples);
      bumpDay(w.day);
    }

    // ---- vendor daily scores ----
    for (const [path, metric] of SCORE_ENDPOINTS) {
      const daily = await fetchPages(path, token, startDate, endDate);
      if (daily.error) return { error: daily.error, status: daily.status };
      if (daily.truncated) truncated = true;
      for (const d of daily.items) {
        raw.push(d);
        const sample = mapOuraDailyScore(d, metric);
        if (!sample) {
          skipped++;
          continue;
        }
        samples.push(sample);
        bumpDay(d.day);
      }
    }

    return {
      batch: { activities, bodyMetrics, samples },
      raw,
      skipped,
      truncated,
      nextCursor: newestDay,
    };
  },
};

// Pull sleep, workouts and Oura's daily scores with a personal access token, and
// upsert them. Runs from both the generic "Sync now" action and the hourly notify
// tick — so, like every pull, it must never touch a Next.js request-scoped API.
export async function runOuraSync(
  profileId: number
): Promise<OuraSyncResult | { error: string }> {
  return runPullSync(profileId, ouraSpec);
}
