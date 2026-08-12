import { createLogger } from "@/lib/log";
import { addCanonicalNames, reconcileFlags } from "@/lib/queries";
import {
  WITHINGS_ID,
  getWithingsAccessToken,
  getWithingsCursor,
  setWithingsCursor,
} from "./connections";
import {
  WITHINGS_MEAS_TYPES,
  WITHINGS_SLEEP_FIELDS,
  mapWithingsMeasureGroup,
  mapWithingsSleep,
} from "./withings";
import { pullPaging } from "./registry";
import { pageOutcome, pullSecondsWindow } from "./pull-window";
import { runPullSync, type PullOutcome, type PullSpec } from "./pull-sync";
import type { NormBodyMetric, NormMetricSample, NormVital } from "./normalize";

// Withings' half of the shared pull runner (#2040): the two endpoints, the
// `offset`/`more` pagination, the `{status, body}` envelope, and row mapping.
// Everything either side of that — timeout and page bounds, the rate-limit →
// truncate-and-keep-cursor rule, the transaction, the cursor decision, and the
// sync-event accounting — belongs to lib/integrations/pull-sync.ts and
// lib/integrations/pull-window.ts, shared with Oura and Strava. This file used to
// carry its own copy of all of it and said so ("Mirrors oura-sync.ts").
//
// Measures use Withings' `lastupdate` incremental cursor (its `updatetime` echo is
// the next cursor); sleep uses a trailing ymd window. Both are idempotent — upserts
// key on (date, source) / external_id / the sleep window — so the trailing re-scan
// never double-counts.

const log = createLogger("withings-sync");

const BASE = "https://wbsapi.withings.net";
const MEASURE_PATH = "/measure";
const SLEEP_PATH = "/v2/sleep";
const { timeoutMs, maxPages, rescanDays, backfillDays } =
  pullPaging(WITHINGS_ID);
// Withings signals over-quota either as HTTP 429 (the shared rule) or the envelope
// status 601 with HTTP 200 — its own dialect of the same "slow down".
const RATE_LIMIT_STATUSES = [601];

export interface WithingsSyncResult {
  bodyMetrics: number;
  vitals: number;
  samples: number;
  skipped: number;
  truncated?: true;
}

type WGet =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error?: string };

async function withingsPost(
  path: string,
  token: string,
  params: Record<string, string>
): Promise<WGet> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as Record<string, unknown>;
    // Withings wraps everything in { status, body }; status 0 = success. An error
    // (bad/expired token, rate limit) rides in the envelope with HTTP 200, so the
    // envelope status is authoritative.
    const status = typeof json.status === "number" ? json.status : -1;
    if (status !== 0) return { ok: false, status };
    const body =
      json.body && typeof json.body === "object"
        ? (json.body as Record<string, unknown>)
        : {};
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

function ymd(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

interface PageResult {
  items: Record<string, unknown>[];
  timezone: string;
  updatetime: number | null;
  truncated: boolean;
  error?: string;
}

// Follow Withings' offset/more pagination, accumulating the array under `listKey`
// (measuregrps / series). A rate limit truncates (partial items kept, cursor held);
// any other non-OK status returns an error. A still-present `more` at the page cap
// also truncates.
async function fetchPages(
  path: string,
  token: string,
  baseParams: Record<string, string>,
  listKey: string
): Promise<PageResult> {
  const items: Record<string, unknown>[] = [];
  let timezone = "UTC";
  let updatetime: number | null = null;
  let offset: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await withingsPost(path, token, {
      ...baseParams,
      ...(offset ? { offset } : {}),
    });
    if (!res.ok) {
      if (pageOutcome(res.status, RATE_LIMIT_STATUSES) === "truncate")
        return { items, timezone, updatetime, truncated: true };
      return {
        items,
        timezone,
        updatetime,
        truncated: false,
        error: `Withings ${path} request failed (${res.status})`,
      };
    }
    const body = res.body;
    if (typeof body.timezone === "string" && body.timezone) {
      timezone = body.timezone;
    }
    if (typeof body.updatetime === "number") {
      updatetime = Math.max(updatetime ?? 0, body.updatetime);
    }
    const list = body[listKey];
    if (Array.isArray(list)) {
      for (const it of list)
        if (it && typeof it === "object")
          items.push(it as Record<string, unknown>);
    }
    if (truthy(body.more) && body.offset != null) {
      offset = String(body.offset);
    } else {
      return { items, timezone, updatetime, truncated: false };
    }
  }
  // Hit the page cap with more to fetch — keep the cursor and resume next run.
  return { items, timezone, updatetime, truncated: true };
}

const withingsSpec: PullSpec<
  string,
  number,
  Omit<WithingsSyncResult, "truncated">
> = {
  id: WITHINGS_ID,
  // A refresh that cannot complete THROWS, and the runner records that as a failed
  // sync event; the refresh path itself owns the needs_reauth transition, which is
  // why the gather below reports no status to reauth on.
  authorize: (profileId) => getWithingsAccessToken(profileId),
  cursor: {
    read: getWithingsCursor,
    write: setWithingsCursor,
    policy: "hold-on-truncate",
  },
  summarize: (t) => ({
    bodyMetrics: t.bodyMetrics,
    vitals: t.vitals,
    samples: t.samples,
    skipped: t.skipped,
  }),

  // Post-commit reconcile (mirrors the Health Connect ingest): register new canonical
  // names and (re)compute out-of-range flags for the imported vitals. Runs AFTER the
  // transaction committed, so a failure here must NOT be recorded as a failed sync —
  // the batch already landed. Log and continue.
  afterCommit(profileId, commit, batch) {
    if (!commit.vitalIds.length) return;
    try {
      addCanonicalNames((batch.vitals ?? []).map((v) => v.canonical));
      reconcileFlags(profileId, commit.vitalIds);
    } catch (err) {
      log.error("withings post-commit reconcile failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async gather(_profileId, token, cursor): Promise<PullOutcome<number>> {
    const nowSec = Math.floor(Date.now() / 1000);
    const bodyMetrics: NormBodyMetric[] = [];
    const vitals: NormVital[] = [];
    const samples: NormMetricSample[] = [];
    const raw: unknown[] = [];
    let skipped = 0;
    let truncated = false;

    // The one shared window rule, in this source's units: a trailing re-scan
    // before the cursor, or the first-run backfill when there is none yet.
    const { startSec, endSec } = pullSecondsWindow(
      cursor,
      nowSec,
      rescanDays,
      backfillDays
    );

    // ---- measures (incremental via lastupdate; date-range on first run) ----
    const measureParams: Record<string, string> = {
      action: "getmeas",
      category: "1", // real measurements only (exclude user objectives)
      meastypes: WITHINGS_MEAS_TYPES.join(","),
      // Incremental once there is a cursor; an explicit backfill range on the first
      // run. Both edges come from the shared window above.
      ...(cursor > 0
        ? { lastupdate: String(startSec) }
        : { startdate: String(startSec), enddate: String(endSec) }),
    };
    const meas = await fetchPages(
      MEASURE_PATH,
      token,
      measureParams,
      "measuregrps"
    );
    if (meas.error) return { error: meas.error };
    if (meas.truncated) truncated = true;
    for (const g of meas.items) {
      raw.push(g);
      const mapped = mapWithingsMeasureGroup(g, meas.timezone);
      if (!mapped) {
        skipped++;
        continue;
      }
      if (mapped.bodyMetric) bodyMetrics.push(mapped.bodyMetric);
      vitals.push(...mapped.vitals);
      // Body-composition point samples (lean/muscle/bone mass, body water) ride the
      // same metric_samples upsert as sleep below (issue #419).
      samples.push(...mapped.samples);
    }

    // ---- sleep summaries (trailing ymd window) ----
    const sleepParams: Record<string, string> = {
      action: "getsummary",
      startdateymd: ymd(startSec),
      enddateymd: ymd(endSec),
      data_fields: WITHINGS_SLEEP_FIELDS.join(","),
    };
    const sleep = await fetchPages(SLEEP_PATH, token, sleepParams, "series");
    if (sleep.error) return { error: sleep.error };
    if (sleep.truncated) truncated = true;
    for (const s of sleep.items) {
      raw.push(s);
      const mapped = mapWithingsSleep(s, sleep.timezone);
      if (!mapped) {
        skipped++;
        continue;
      }
      samples.push(...mapped.samples);
    }

    return {
      batch: { bodyMetrics, vitals, samples },
      raw,
      skipped,
      truncated,
      // The newest server updatetime is the next cursor; with none echoed, "now" is
      // the honest high-water mark for an incremental endpoint that returned nothing.
      nextCursor: meas.updatetime ?? nowSec,
    };
  },
};

// Pull measures (weight/body composition, BP/SpO2/temperature, heart pulse) and sleep
// summaries, and upsert them. Runs from both the generic "Sync now" action and the
// hourly notify tick — so, like every pull, it must never touch a Next.js
// request-scoped API.
export async function runWithingsSync(
  profileId: number
): Promise<WithingsSyncResult | { error: string }> {
  return runPullSync(profileId, withingsSpec);
}
