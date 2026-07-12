import { db, writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import {
  OURA_ID,
  getOuraToken,
  getOuraCursor,
  setOuraCursor,
  recordSync,
  recordSyncEvent,
  markConnectionNeedsReauth,
} from "./connections";
import { isAuthRefreshFailure } from "./auth-failure";
import {
  summarizeSplit,
  foldCounts,
  emptyCounts,
  dateWindow,
  type UpsertCounts,
} from "./sync-log";
import { mapOuraSleep, mapOuraWorkout } from "./oura";
import { writeRawPayload } from "./raw-log";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertMetricSamples,
  type NormActivity,
  type NormBodyMetric,
  type NormMetricSample,
} from "./normalize";

// Pulls sleep + workouts from the Oura API v2 with a personal access token and
// upserts them. Runs from both the "Sync now" server action and the hourly notify
// tick, so it must NOT touch any Next.js request-scoped API (revalidatePath) —
// callers revalidate. Mirrors strava-sync.ts: cursor-based incremental pull, bounded
// paging, 429 → truncate-and-keep-cursor, one sync event with the insert/update/
// unchanged split.

const log = createLogger("oura-sync");

const BASE = "https://api.ouraring.com";
// Short server-side timeout so a hung Oura request never stalls the tick.
const TIMEOUT_MS = 15_000;
// Safety cap on pages per endpoint per run: an unbounded next_token loop can't spin
// forever. A remaining next_token at the cap marks the run truncated (cursor kept).
const MAX_PAGES = 25;
// Re-scan window (days) subtracted from the cursor each run: a sleep period or
// workout can be finalized/edited a day or two after its date, so re-fetching a
// trailing window catches late edits. Upserts are keyed on window/external_id, so
// re-fetches are idempotent.
const RESCAN_DAYS = 3;
// First-ever sync backfills this many days (Oura requires an explicit start_date);
// successive runs advance the cursor and stay incremental.
const INITIAL_BACKFILL_DAYS = 30;

export interface OuraSyncResult {
  workouts: number;
  bodyMetrics: number;
  samples: number;
  skipped: number;
  truncated?: boolean;
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (err) {
    // Network error / timeout / DNS: surface as a non-HTTP failure (status 0) so the
    // caller records a failed sync event and returns gracefully instead of throwing.
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
  // personal access token was revoked, so the caller marks the connection
  // needs_reauth. Null/absent on success or a network error (status 0).
  status?: number;
}

// Follow Oura's next_token pagination over a date range, accumulating `data` items.
// A 429 truncates (partial items kept, caller keeps the cursor); any other non-OK
// status returns an error. A still-present next_token at MAX_PAGES also truncates.
async function fetchPages(
  path: string,
  token: string,
  startDate: string,
  endDate: string
): Promise<PageResult> {
  const items: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });
    if (nextToken) qs.set("next_token", nextToken);
    const res = await ouraGet(`${path}?${qs.toString()}`, token);
    if (!res.ok) {
      if (res.status === 429) return { items, truncated: true };
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

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runOuraSync(
  profileId: number
): Promise<OuraSyncResult | { error: string }> {
  const token = getOuraToken(profileId);
  // Not a sync attempt (not connected) — nothing to log.
  if (!token) return { error: "not connected" };

  const cursor = getOuraCursor(profileId);
  const today = todayUtc();
  // Page from a trailing window before the cursor so late-finalized nights/workouts
  // aren't skipped; end a day past today to cover ring-vs-server timezone slack.
  const startDate = cursor
    ? addDays(cursor, -RESCAN_DAYS)
    : addDays(today, -INITIAL_BACKFILL_DAYS);
  const endDate = addDays(today, 1);

  const acts: NormActivity[] = [];
  const bodyMetrics: NormBodyMetric[] = [];
  const samples: NormMetricSample[] = [];
  const rawItems: unknown[] = [];
  let skipped = 0;
  let truncated = false;
  let newestDay = cursor ?? "";

  const bumpDay = (d: string | null | undefined) => {
    if (d && d > newestDay) newestDay = d;
  };

  // ---- sleep ----
  const sleep = await fetchPages(
    "/v2/usercollection/sleep",
    token,
    startDate,
    endDate
  );
  if (sleep.error) {
    // A revoked personal access token surfaces as a 401 on the pull — flip to
    // needs_reauth so the tick stops retrying it forever (issue #326).
    if (sleep.status != null && isAuthRefreshFailure(sleep.status)) {
      markConnectionNeedsReauth(profileId, OURA_ID);
    }
    recordSyncEvent(profileId, OURA_ID, { ok: false, error: sleep.error });
    return { error: sleep.error };
  }
  if (sleep.truncated) truncated = true;
  for (const s of sleep.items) {
    rawItems.push(s);
    const mapped = mapOuraSleep(s);
    if (!mapped) {
      skipped++;
      continue;
    }
    samples.push(...mapped.samples);
    if (mapped.bodyMetric) bodyMetrics.push(mapped.bodyMetric);
    bumpDay(typeof s.day === "string" ? s.day : null);
  }

  // ---- workouts ----
  const workouts = await fetchPages(
    "/v2/usercollection/workout",
    token,
    startDate,
    endDate
  );
  if (workouts.error) {
    if (workouts.status != null && isAuthRefreshFailure(workouts.status)) {
      markConnectionNeedsReauth(profileId, OURA_ID);
    }
    recordSyncEvent(profileId, OURA_ID, { ok: false, error: workouts.error });
    return { error: workouts.error };
  }
  if (workouts.truncated) truncated = true;
  for (const w of workouts.items) {
    rawItems.push(w);
    const mapped = mapOuraWorkout(w);
    if (!mapped) {
      skipped++;
      continue;
    }
    acts.push(mapped.activity);
    samples.push(...mapped.samples);
    bumpDay(typeof w.day === "string" ? w.day : null);
  }

  let upActivities: UpsertCounts = emptyCounts();
  let upBody: UpsertCounts = emptyCounts();
  let upSamples: UpsertCounts = emptyCounts();
  try {
    writeTx(() => {
      upActivities = upsertActivities(profileId, acts, OURA_ID);
      upBody = upsertBodyMetrics(profileId, bodyMetrics, OURA_ID);
      upSamples = upsertMetricSamples(profileId, samples, OURA_ID);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const win = dateWindow([
      ...acts.map((a) => a.date),
      ...bodyMetrics.map((b) => b.date),
      ...samples.map((s) => s.date),
    ]);
    recordSyncEvent(profileId, OURA_ID, {
      ok: false,
      windowStart: win.start,
      windowEnd: win.end,
      error: message,
    });
    return { error: message };
  }

  // Advance the cursor to the newest day fully processed — but NEVER when truncated,
  // so a rate-limited/capped run re-fetches the whole window next time rather than
  // stranding un-synced days past the re-scan margin.
  if (!truncated && newestDay && newestDay > (cursor ?? "")) {
    setOuraCursor(profileId, newestDay);
  }

  const total = (c: UpsertCounts) => c.inserted + c.updated + c.unchanged;
  const actTotal = total(upActivities);
  const bodyTotal = total(upBody);
  const sampleTotal = total(upSamples);

  const summary: OuraSyncResult = {
    workouts: actTotal,
    bodyMetrics: bodyTotal,
    samples: sampleTotal,
    skipped,
    ...(truncated ? { truncated: true } : {}),
  };
  recordSync(profileId, OURA_ID, {
    workouts: actTotal,
    bodyMetrics: bodyTotal,
    samples: sampleTotal,
    skipped,
    truncated: truncated ? 1 : 0,
  });
  {
    const win = dateWindow([
      ...acts.map((a) => a.date),
      ...bodyMetrics.map((b) => b.date),
      ...samples.map((s) => s.date),
    ]);
    const tally = summarizeSplit(
      foldCounts([upActivities, upBody, upSamples]),
      skipped
    );
    const rawRef = writeRawPayload(
      profileId,
      OURA_ID,
      JSON.stringify(rawItems)
    );
    recordSyncEvent(profileId, OURA_ID, {
      ok: true,
      windowStart: win.start,
      windowEnd: win.end,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      skipped: tally.skipped,
      raw_ref: rawRef,
    });
  }
  if (truncated) {
    log.info("oura sync truncated (page cap / rate limit)", {
      workouts: actTotal,
      samples: sampleTotal,
      skipped,
    });
  }
  return summary;
}
