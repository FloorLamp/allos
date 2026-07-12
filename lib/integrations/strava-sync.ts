import { db, writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import {
  STRAVA_ID,
  getStravaAccessToken,
  getStravaCursor,
  recordSync,
  recordSyncEvent,
  setStravaCursor,
} from "./connections";
import {
  summarizeSplit,
  foldCounts,
  emptyCounts,
  dateWindow,
  type UpsertCounts,
} from "./sync-log";
import { mapStravaActivity } from "./strava";
import { writeRawPayload } from "./raw-log";
import {
  upsertActivities,
  upsertActivityRoutes,
  upsertMetricSamples,
  type NormActivity,
  type NormMetricSample,
  type NormActivityRoute,
} from "./normalize";

// Pulls activities from the Strava API and upserts them. Runs both from the
// "Sync now" server action and the hourly notify tick, so it must NOT touch any
// Next.js request-scoped API (e.g. revalidatePath) — callers revalidate.

const log = createLogger("strava-sync");

const API = "https://www.strava.com/api/v3";
const PER_PAGE = 200;
// Each new activity costs one extra request (the detail call for calories). Cap
// the detail calls per run so a first-time backfill of a large history doesn't
// blow Strava's 200-requests/15-min limit; the cursor advances each run, so
// successive hourly syncs catch up.
const MAX_DETAIL_CALLS = 150;
// Re-scan window subtracted from the stored cursor when paging. The cursor tracks
// the newest activity *start* time, but an activity recorded on an offline device
// can be uploaded days later with an older start — a strict `after = cursor` would
// skip it forever. Re-fetching a trailing window each run catches those late
// uploads; upserts are keyed on external_id, so re-fetches are idempotent.
const RESCAN_MARGIN_SEC = 7 * 24 * 60 * 60;
// Short server-side timeout so a hung/blackholed Strava request never stalls the
// hourly tick (issue #476). The tick processes profiles SEQUENTIALLY, so one fetch
// with no AbortSignal — a connection that opens but never responds — would freeze the
// whole run: no dose reminders, no escalations, no backups that hour.
const TIMEOUT_MS = 30_000;

export interface StravaSyncResult {
  activities: number;
  samples: number;
  skipped: number;
  truncated?: boolean; // hit the per-run detail-call cap; more remain
}

async function stravaGet(
  path: string,
  token: string
): Promise<
  { ok: true; json: unknown } | { ok: false; status: number; error?: string }
> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (err) {
    // A network THROW (DNS failure, ECONNRESET, TLS error, or the timeout above)
    // rejects `fetch`. Convert it to a non-ok result — the same shape Withings'
    // withingsPost returns (issue #476) — so the caller records an ok:false sync
    // event instead of letting the rejection escape runStravaSync unlogged, which
    // left Review green while Strava had silently stopped syncing. status 0 marks
    // "no HTTP response"; the message carries the real cause for the event.
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runStravaSync(
  profileId: number
): Promise<StravaSyncResult | { error: string }> {
  let token: string | null;
  try {
    token = await getStravaAccessToken(profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncEvent(profileId, STRAVA_ID, { ok: false, error: message });
    return { error: message };
  }
  // Not a sync attempt (no credentials / not connected yet) — nothing to log.
  if (!token) return { error: "not connected" };

  const cursor = getStravaCursor(profileId);
  // Page from a trailing window before the cursor so late-uploaded activities
  // (older start, recent upload) aren't skipped.
  const after = Math.max(0, cursor - RESCAN_MARGIN_SEC);
  const acts: NormActivity[] = [];
  const samples: NormMetricSample[] = [];
  const routes: NormActivityRoute[] = [];
  // Raw fetched activity JSON (detailed when available, else the list summary),
  // accumulated for the admin-only raw viewer (issue #9) and written once below.
  const rawItems: unknown[] = [];
  let skipped = 0;
  let detailCalls = 0;
  let truncated = false;
  let newestStart = cursor;

  // Page oldest-first via `after`; stop on a short page.
  for (let page = 1; ; page++) {
    const listRes = await stravaGet(
      `/athlete/activities?after=${after}&page=${page}&per_page=${PER_PAGE}`,
      token
    );
    if (!listRes.ok) {
      if (listRes.status === 429) {
        truncated = true;
        break; // rate-limited — keep the cursor, resume next run
      }
      {
        // status 0 = a network throw/timeout caught in stravaGet; surface its real
        // cause (ECONNRESET / timeout) so the failed sync event is actionable, not a
        // bare "(0)".
        const message = listRes.error
          ? `Strava activities request failed: ${listRes.error}`
          : `Strava activities request failed (${listRes.status})`;
        recordSyncEvent(profileId, STRAVA_ID, { ok: false, error: message });
        return { error: message };
      }
    }
    const list = Array.isArray(listRes.json)
      ? (listRes.json as Record<string, unknown>[])
      : [];
    if (list.length === 0) break;

    for (const summary of list) {
      // Calories come only from the detailed activity. When we can't fetch it —
      // the per-run cap is reached or Strava rate-limits us — stop BEFORE
      // importing this activity, leaving the cursor behind it so the next run
      // resumes here and imports it WITH calories (rather than storing it
      // calorie-less and advancing past it forever).
      if (detailCalls >= MAX_DETAIL_CALLS) {
        truncated = true;
        break;
      }
      const detailRes = await stravaGet(`/activities/${summary.id}`, token);
      detailCalls++;
      if (!detailRes.ok && detailRes.status === 429) {
        truncated = true;
        break;
      }
      // A non-429 detail failure (e.g. a deleted/forbidden activity) imports
      // without calories rather than stalling all newer activities on one bad id.
      const detail = detailRes.ok ? detailRes.json : undefined;
      // Keep the raw provider JSON for the raw viewer, whether or not it maps.
      rawItems.push(detail ?? summary);

      const mapped = mapStravaActivity(summary, detail);
      if (!mapped) {
        skipped++;
        continue;
      }
      acts.push(mapped.activity);
      samples.push(...mapped.samples);
      if (mapped.route) routes.push(mapped.route);
      const startSec = Math.floor(
        new Date(String(summary.start_date)).getTime() / 1000
      );
      if (Number.isFinite(startSec) && startSec > newestStart)
        newestStart = startSec;
    }

    if (truncated || list.length < PER_PAGE) break;
  }

  let upActivities: UpsertCounts = emptyCounts();
  let upSamples: UpsertCounts = emptyCounts();
  try {
    writeTx(() => {
      upActivities = upsertActivities(profileId, acts, STRAVA_ID);
      upSamples = upsertMetricSamples(profileId, samples, STRAVA_ID);
      // Routes resolve their parent activity by external_id, so this must run after
      // upsertActivities (same tx). Idempotent; not folded into the sync tally — a
      // route is a side artifact of the activity it belongs to, not its own record.
      upsertActivityRoutes(profileId, routes, STRAVA_ID);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const win = dateWindow([
      ...acts.map((a) => a.date),
      ...samples.map((s) => s.date),
    ]);
    recordSyncEvent(profileId, STRAVA_ID, {
      ok: false,
      windowStart: win.start,
      windowEnd: win.end,
      error: message,
    });
    return { error: message };
  }

  // Advance the cursor to the newest activity we successfully processed, so the
  // next run's trailing window starts from there. (When truncated, newestStart
  // only reflects what we got through, so we never skip un-synced activities.)
  if (newestStart > cursor) setStravaCursor(profileId, newestStart);

  // Flat per-type totals (inserted + updated + unchanged) for the legacy
  // StravaSyncResult / last_sync_summary / log.info.
  const total = (c: UpsertCounts) => c.inserted + c.updated + c.unchanged;
  const actTotal = total(upActivities);
  const sampleTotal = total(upSamples);

  const summary: StravaSyncResult = {
    activities: actTotal,
    samples: sampleTotal,
    skipped,
    ...(truncated ? { truncated: true } : {}),
  };
  recordSync(profileId, STRAVA_ID, {
    activities: actTotal,
    samples: sampleTotal,
    skipped,
    truncated: truncated ? 1 : 0,
  });
  // Best-effort debug event: one per run with the real insert/update/unchanged
  // split (written = inserted + updated + unchanged; a re-fetched trailing-window
  // activity that hasn't changed is now counted unchanged, not written). skipped =
  // rows mapped-away by mapStravaActivity. recordSyncEvent never throws into the sync.
  {
    const win = dateWindow([
      ...acts.map((a) => a.date),
      ...samples.map((s) => s.date),
    ]);
    const tally = summarizeSplit(
      foldCounts([upActivities, upSamples]),
      skipped
    );
    // Best-effort raw capture (never throws): the JSON we fetched this run.
    const rawRef = writeRawPayload(
      profileId,
      STRAVA_ID,
      JSON.stringify(rawItems)
    );
    recordSyncEvent(profileId, STRAVA_ID, {
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
    log.info("strava sync truncated (detail-call cap / rate limit)", {
      activities: actTotal,
      samples: sampleTotal,
      skipped,
    });
  }
  return summary;
}
