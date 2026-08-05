import { createLogger } from "@/lib/log";
import { getTimezone } from "@/lib/settings";
import {
  STRAVA_ID,
  getStravaAccessToken,
  getStravaCursor,
  setStravaCursor,
} from "./connections";
import { mapStravaActivity, mapStravaCyclingArtifacts } from "./strava";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { pullPaging } from "./registry";
import { isPullRateLimited, DAY_SECONDS } from "./pull-window";
import { runPullSync, type PullOutcome, type PullSpec } from "./pull-sync";
import type {
  NormActivity,
  NormActivityRoute,
  NormMetricSample,
} from "./normalize";
import {
  STRAVA_STREAM_KEYS,
  type NormActivityLap,
  type NormCyclingTelemetry,
  type NormSegmentEffort,
} from "./cycling-telemetry";

// Strava's half of the shared pull runner (#2040): the list+detail request pair, the
// `page`/`per_page` pagination, and row mapping. Everything either side of that —
// timeout and call bounds, the rate-limit → truncate rule, the transaction, the
// cursor decision, and the sync-event accounting — belongs to
// lib/integrations/pull-sync.ts and lib/integrations/pull-window.ts, shared with Oura
// and Withings.

const log = createLogger("strava-sync");

const API = "https://www.strava.com/api/v3";
const PER_PAGE = 200;
const {
  timeoutMs,
  maxPages: maxDetailCalls,
  rescanDays,
} = pullPaging(STRAVA_ID);
const RESCAN_MARGIN_SEC = rescanDays * DAY_SECONDS;

export interface StravaSyncResult {
  activities: number;
  samples: number;
  skipped: number;
  truncated?: true; // hit the per-run detail-call cap; more remain
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (err) {
    // A network THROW (DNS failure, ECONNRESET, TLS error, or the timeout above)
    // rejects `fetch`. Convert it to a non-ok result — the same shape Withings'
    // withingsPost returns (issue #476) — so the runner records an ok:false sync
    // event instead of letting the rejection escape unlogged, which left Review green
    // while Strava had silently stopped syncing. status 0 marks "no HTTP response";
    // the message carries the real cause for the event.
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const stravaSpec: PullSpec<
  string,
  number,
  Omit<StravaSyncResult, "truncated">
> = {
  id: STRAVA_ID,
  authorize: (profileId) => getStravaAccessToken(profileId),
  cursor: {
    read: getStravaCursor,
    write: setStravaCursor,
    // Strava's cursor is computed row by row as the loop imports, so it never points
    // past un-imported data even when the run was cut short — and holding it back
    // would re-pay every detail call the truncated run already spent.
    policy: "advance-to-processed",
  },
  summarize: (t) => ({
    activities: t.activities,
    samples: t.samples,
    skipped: t.skipped,
  }),
  truncationReason: "detail-call cap / rate limit",

  // High-confidence auto-merge (#1081): a freshly-inserted Strava activity that
  // overlaps a Health Connect / manual row for the same session collapses now
  // (through the same core + tombstone + decision path), so the duplicate never
  // reaches Review. The runner isolates it, so a merge failure can't fail the sync.
  afterCommit(profileId, commit) {
    if (commit.activities.inserted === 0) return;
    try {
      autoMergeActivityDuplicates(profileId);
    } catch (err) {
      log.error("auto-merge failed after Strava sync", {
        profileId,
        err: String(err),
      });
    }
  },

  async gather(profileId, token, cursor): Promise<PullOutcome<number>> {
    // The PROFILE's timezone, read once per run. It is what turns Strava's true
    // `start_date` instant into the local day and clock the activity belongs on
    // (#2088) — the ingest-side close of the wrong-`utc_offset` family, instead of
    // trusting the `start_date_local` Strava computed from an offset it may have
    // had stale.
    const tz = getTimezone(profileId);
    // Page from a trailing window before the cursor so late-uploaded activities
    // (older start, recent upload) aren't skipped.
    const after = Math.max(0, cursor - RESCAN_MARGIN_SEC);
    const activities: NormActivity[] = [];
    const samples: NormMetricSample[] = [];
    const routes: NormActivityRoute[] = [];
    const cyclingTelemetry: NormCyclingTelemetry[] = [];
    const activityLaps: NormActivityLap[] = [];
    const segmentEfforts: NormSegmentEffort[] = [];
    const cyclingArtifactParents: string[] = [];
    // Raw fetched activity JSON (detailed when available, else the list summary),
    // accumulated for the admin-only raw viewer (issue #9).
    const raw: unknown[] = [];
    let skipped = 0;
    let detailCalls = 0;
    let truncated = false;
    let newestStart = cursor;
    const snapshotAt = new Date().toISOString();

    // Optional for backward-compatible connections: an older token without
    // profile:read_all receives 403 and still imports rides, streams, laps, and
    // segments. Reconnecting grants FTP and athlete-zone snapshots.
    const athleteRes = await stravaGet("/athlete", token);
    const athlete = athleteRes.ok ? athleteRes.json : null;
    const zonesRes = await stravaGet("/athlete/zones", token);
    const zones = zonesRes.ok ? zonesRes.json : null;

    // Page oldest-first via `after`; stop on a short page.
    for (let page = 1; ; page++) {
      const listRes = await stravaGet(
        `/athlete/activities?after=${after}&page=${page}&per_page=${PER_PAGE}`,
        token
      );
      if (!listRes.ok) {
        if (isPullRateLimited(listRes.status)) {
          truncated = true;
          break; // rate-limited — keep what we processed, resume next run
        }
        // status 0 = a network throw/timeout caught in stravaGet; surface its real
        // cause (ECONNRESET / timeout) so the failed sync event is actionable, not a
        // bare "(0)".
        return {
          error: listRes.error
            ? `Strava activities request failed: ${listRes.error}`
            : `Strava activities request failed (${listRes.status})`,
        };
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
        if (detailCalls >= maxDetailCalls) {
          truncated = true;
          break;
        }
        const detailRes = await stravaGet(`/activities/${summary.id}`, token);
        detailCalls++;
        if (!detailRes.ok && isPullRateLimited(detailRes.status)) {
          truncated = true;
          break;
        }
        // A non-429 detail failure (e.g. a deleted/forbidden activity) imports
        // without calories rather than stalling all newer activities on one bad id.
        const detail = detailRes.ok ? detailRes.json : undefined;
        // Keep the raw provider JSON for the raw viewer, whether or not it maps.
        raw.push(detail ?? summary);

        const mapped = mapStravaActivity(summary, detail, tz);
        if (!mapped) {
          skipped++;
          continue;
        }
        const sportType = String(summary.sport_type ?? summary.type ?? "");
        const cycling = [
          "Ride",
          "GravelRide",
          "MountainBikeRide",
          "EBikeRide",
          "VirtualRide",
        ].includes(sportType);
        if (cycling) {
          if (detailCalls >= maxDetailCalls) {
            truncated = true;
            break;
          }
          const keys = STRAVA_STREAM_KEYS.join(",");
          const streamRes = await stravaGet(
            `/activities/${summary.id}/streams?keys=${keys}&key_by_type=true`,
            token
          );
          detailCalls++;
          if (!streamRes.ok && isPullRateLimited(streamRes.status)) {
            truncated = true;
            break;
          }
          const artifacts = mapStravaCyclingArtifacts(
            String(summary.id),
            detail,
            streamRes.ok ? streamRes.json : null,
            athlete,
            zones,
            snapshotAt
          );
          cyclingTelemetry.push(artifacts.telemetry);
          activityLaps.push(...artifacts.laps);
          segmentEfforts.push(...artifacts.segmentEfforts);
          cyclingArtifactParents.push(mapped.activity.external_id);
        }
        activities.push(mapped.activity);
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

    return {
      batch: {
        activities,
        samples,
        routes,
        cyclingTelemetry,
        activityLaps,
        segmentEfforts,
        cyclingArtifactParents,
      },
      raw,
      skipped,
      truncated,
      nextCursor: newestStart,
    };
  },
};

// Pull activities and upsert them. Runs from both the generic "Sync now" action and
// the hourly notify tick — so, like every pull, it must never touch a Next.js
// request-scoped API (e.g. revalidatePath); callers revalidate.
export async function runStravaSync(
  profileId: number
): Promise<StravaSyncResult | { error: string }> {
  return runPullSync(profileId, stravaSpec);
}
