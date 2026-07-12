import { db, writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { addCanonicalNames, reconcileFlags } from "@/lib/queries";
import {
  WITHINGS_ID,
  getWithingsAccessToken,
  getWithingsCursor,
  setWithingsCursor,
  recordSync,
  recordSyncEvent,
} from "./connections";
import {
  summarizeSplit,
  foldCounts,
  emptyCounts,
  dateWindow,
  type UpsertCounts,
} from "./sync-log";
import {
  WITHINGS_MEAS_TYPES,
  WITHINGS_SLEEP_FIELDS,
  mapWithingsMeasureGroup,
  mapWithingsSleep,
} from "./withings";
import { writeRawPayload } from "./raw-log";
import {
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertVitals,
  type NormBodyMetric,
  type NormMetricSample,
  type NormVital,
} from "./normalize";

// Pulls measures (weight/body composition, BP/SpO2/temperature, heart pulse) and
// sleep summaries from the Withings API and upserts them. Runs both from the "Sync
// now" server action and the hourly notify tick, so it must NOT touch any Next.js
// request-scoped API (revalidatePath) — callers revalidate. Mirrors oura-sync.ts:
// bounded paging, rate-limit → truncate-and-keep-cursor, one sync event with the
// insert/update/unchanged split. Measures use Withings' `lastupdate` incremental
// cursor (its `updatetime` echo is the next cursor); sleep uses a trailing ymd
// window. Both are idempotent — upserts key on (date, source) / external_id / the
// sleep window — so the trailing re-scan never double-counts.

const log = createLogger("withings-sync");

const BASE = "https://wbsapi.withings.net";
const MEASURE_PATH = "/measure";
const SLEEP_PATH = "/v2/sleep";
// Short server-side timeout so a hung Withings request never stalls the tick.
const TIMEOUT_MS = 15_000;
// Safety cap on pages per endpoint per run: an unbounded offset loop can't spin
// forever. Remaining `more` at the cap marks the run truncated (cursor kept).
const MAX_PAGES = 25;
// Re-scan window (days) subtracted from the cursor each run: a measure or sleep
// night can be finalized/edited a day or two later, so re-fetching a trailing
// window catches late edits. Upserts are keyed, so re-fetches are idempotent.
const RESCAN_DAYS = 3;
// First-ever sync backfills this many days.
const INITIAL_BACKFILL_DAYS = 30;
const DAY_SEC = 86_400;

export interface WithingsSyncResult {
  bodyMetrics: number;
  vitals: number;
  samples: number;
  skipped: number;
  truncated?: boolean;
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

// Withings signals over-quota either as HTTP 429 or the envelope status 601.
function isRateLimited(status: number): boolean {
  return status === 429 || status === 601;
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
// (measuregrps / series). A rate limit truncates (partial items kept, caller keeps
// the cursor); any other non-OK status returns an error. A still-present `more` at
// MAX_PAGES also truncates.
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
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await withingsPost(path, token, {
      ...baseParams,
      ...(offset ? { offset } : {}),
    });
    if (!res.ok) {
      if (isRateLimited(res.status))
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

export async function runWithingsSync(
  profileId: number
): Promise<WithingsSyncResult | { error: string }> {
  let token: string | null;
  try {
    token = await getWithingsAccessToken(profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncEvent(profileId, WITHINGS_ID, { ok: false, error: message });
    return { error: message };
  }
  // Not a sync attempt (no credentials / not connected yet) — nothing to log.
  if (!token) return { error: "not connected" };

  const cursor = getWithingsCursor(profileId);
  const nowSec = Math.floor(Date.now() / 1000);

  const bodyMetrics: NormBodyMetric[] = [];
  const vitals: NormVital[] = [];
  const samples: NormMetricSample[] = [];
  const rawItems: unknown[] = [];
  let skipped = 0;
  let truncated = false;

  // ---- measures (incremental via lastupdate; date-range on first run) ----
  const measureParams: Record<string, string> = {
    action: "getmeas",
    category: "1", // real measurements only (exclude user objectives)
    meastypes: WITHINGS_MEAS_TYPES.join(","),
    ...(cursor > 0
      ? { lastupdate: String(Math.max(0, cursor - RESCAN_DAYS * DAY_SEC)) }
      : {
          startdate: String(nowSec - INITIAL_BACKFILL_DAYS * DAY_SEC),
          enddate: String(nowSec + DAY_SEC),
        }),
  };
  const meas = await fetchPages(
    MEASURE_PATH,
    token,
    measureParams,
    "measuregrps"
  );
  if (meas.error) {
    recordSyncEvent(profileId, WITHINGS_ID, { ok: false, error: meas.error });
    return { error: meas.error };
  }
  if (meas.truncated) truncated = true;
  for (const g of meas.items) {
    rawItems.push(g);
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
  const sleepStart =
    cursor > 0
      ? cursor - RESCAN_DAYS * DAY_SEC
      : nowSec - INITIAL_BACKFILL_DAYS * DAY_SEC;
  const sleepParams: Record<string, string> = {
    action: "getsummary",
    startdateymd: ymd(Math.max(0, sleepStart)),
    enddateymd: ymd(nowSec + DAY_SEC),
    data_fields: WITHINGS_SLEEP_FIELDS.join(","),
  };
  const sleep = await fetchPages(SLEEP_PATH, token, sleepParams, "series");
  if (sleep.error) {
    recordSyncEvent(profileId, WITHINGS_ID, { ok: false, error: sleep.error });
    return { error: sleep.error };
  }
  if (sleep.truncated) truncated = true;
  for (const s of sleep.items) {
    rawItems.push(s);
    const mapped = mapWithingsSleep(s, sleep.timezone);
    if (!mapped) {
      skipped++;
      continue;
    }
    samples.push(...mapped.samples);
  }

  let upBody: UpsertCounts = emptyCounts();
  let upVitals: UpsertCounts = emptyCounts();
  let upSamples: UpsertCounts = emptyCounts();
  let vitalIds: number[] = [];
  try {
    writeTx(() => {
      upBody = upsertBodyMetrics(profileId, bodyMetrics, WITHINGS_ID);
      const v = upsertVitals(profileId, vitals, WITHINGS_ID);
      upVitals = v.counts;
      vitalIds = v.ids;
      upSamples = upsertMetricSamples(profileId, samples, WITHINGS_ID);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const win = dateWindow([
      ...bodyMetrics.map((b) => b.date),
      ...vitals.map((v) => v.date),
      ...samples.map((s) => s.date),
    ]);
    recordSyncEvent(profileId, WITHINGS_ID, {
      ok: false,
      windowStart: win.start,
      windowEnd: win.end,
      error: message,
    });
    return { error: message };
  }

  // Post-commit reconcile (mirrors the Health Connect ingest): register new canonical
  // names and (re)compute out-of-range flags for the imported vitals. Runs AFTER the
  // transaction committed, so a failure here must NOT be recorded as a failed sync —
  // the batch already landed. Log-and-continue.
  if (vitalIds.length) {
    try {
      addCanonicalNames(vitals.map((v) => v.canonical));
      reconcileFlags(profileId, vitalIds);
    } catch (err) {
      log.error("withings post-commit reconcile failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Advance the cursor to the newest server updatetime — but NEVER when truncated, so
  // a rate-limited/capped run re-fetches the whole window next time rather than
  // stranding un-synced measurements past the re-scan margin.
  const newestUpdate = meas.updatetime ?? nowSec;
  if (!truncated && newestUpdate > cursor) {
    setWithingsCursor(profileId, newestUpdate);
  }

  const total = (c: UpsertCounts) => c.inserted + c.updated + c.unchanged;
  const bodyTotal = total(upBody);
  const vitalsTotal = total(upVitals);
  const sampleTotal = total(upSamples);

  const summary: WithingsSyncResult = {
    bodyMetrics: bodyTotal,
    vitals: vitalsTotal,
    samples: sampleTotal,
    skipped,
    ...(truncated ? { truncated: true } : {}),
  };
  recordSync(profileId, WITHINGS_ID, {
    bodyMetrics: bodyTotal,
    vitals: vitalsTotal,
    samples: sampleTotal,
    skipped,
    truncated: truncated ? 1 : 0,
  });
  {
    const win = dateWindow([
      ...bodyMetrics.map((b) => b.date),
      ...vitals.map((v) => v.date),
      ...samples.map((s) => s.date),
    ]);
    const tally = summarizeSplit(
      foldCounts([upBody, upVitals, upSamples]),
      skipped
    );
    const rawRef = writeRawPayload(
      profileId,
      WITHINGS_ID,
      JSON.stringify(rawItems)
    );
    recordSyncEvent(profileId, WITHINGS_ID, {
      ok: true,
      windowStart: win.start,
      windowEnd: win.end,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      suppressed: tally.suppressed,
      skipped: tally.skipped,
      raw_ref: rawRef,
    });
  }
  if (truncated) {
    log.info("withings sync truncated (page cap / rate limit)", {
      bodyMetrics: bodyTotal,
      vitals: vitalsTotal,
      samples: sampleTotal,
      skipped,
    });
  }
  return summary;
}
