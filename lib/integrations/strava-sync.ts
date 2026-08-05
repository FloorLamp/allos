import { createLogger } from "@/lib/log";
import { db, writeTx } from "@/lib/db";
import { getTimezone } from "@/lib/settings";
import {
  STRAVA_ID,
  getStravaAccessToken,
  getStravaConfig,
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
  hasCyclingStreamDetails,
  replaceActivityLaps,
  replaceSegmentEfforts,
  STRAVA_STREAM_KEYS,
  upsertCyclingTelemetry,
  type NormActivityLap,
  type NormCyclingTelemetry,
  type NormSegmentEffort,
} from "./cycling-telemetry";
import {
  createStravaRequestBudget,
  type StravaRequestBudget,
} from "./strava-rate-limit";
import { isCyclingActivity } from "@/lib/cycling-activity";

// Strava's half of the shared pull runner (#2040): the list+detail request pair, the
// `page`/`per_page` pagination, and row mapping. Everything either side of that —
// timeout and call bounds, the rate-limit → truncate rule, the transaction, the
// cursor decision, and the sync-event accounting — belongs to
// lib/integrations/pull-sync.ts and lib/integrations/pull-window.ts, shared with Oura
// and Withings.

const log = createLogger("strava-sync");

const API = "https://www.strava.com/api/v3";
const PER_PAGE = 200;
const { timeoutMs, maxPages: maxRequests, rescanDays } = pullPaging(STRAVA_ID);
const RESCAN_MARGIN_SEC = rescanDays * DAY_SECONDS;

function hasImportedStravaActivity(
  profileId: number,
  externalId: string
): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM activities WHERE profile_id = ? AND source = 'strava' AND external_id = ?"
    )
    .get(profileId, externalId);
}

export interface StravaSyncResult {
  activities: number;
  samples: number;
  skipped: number;
  truncated?: true; // hit the per-run detail-call cap; more remain
}

async function stravaGet(
  path: string,
  token: string,
  budget: StravaRequestBudget
): Promise<
  { ok: true; json: unknown } | { ok: false; status: number; error?: string }
> {
  if (!budget.reserve()) {
    return {
      ok: false,
      status: 429,
      error: "Strava read-request budget exhausted",
    };
  }
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    budget.observe(res.headers);
    if (res.status === 429) budget.markRateLimited();
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
  truncationReason: "request cap / read rate limit",

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
    // Laps and segment efforts are full replacements only when DetailedActivity
    // succeeded. A transient detail failure must not make an empty mapper result
    // delete artifacts stored by an earlier trailing-window scan.
    const detailArtifactParents: string[] = [];
    // Raw fetched activity JSON (detailed when available, else the list summary),
    // accumulated for the admin-only raw viewer (issue #9).
    const raw: unknown[] = [];
    let skipped = 0;
    let truncated = false;
    let newestStart = cursor;
    const snapshotAt = new Date().toISOString();
    const clientId = getStravaConfig(profileId).clientId ?? "unconfigured";
    const budget = createStravaRequestBudget(clientId, maxRequests);
    let athlete: unknown = null;
    let zones: unknown = null;
    let snapshotsLoaded = false;

    async function loadSnapshots(): Promise<boolean> {
      if (snapshotsLoaded) return true;
      // Optional for backward-compatible connections: an older token without
      // profile:read_all receives 403 and still imports ride details. Only a rate
      // limit stops the row so a later run can retry the whole artifact set.
      const athleteRes = await stravaGet("/athlete", token, budget);
      if (!athleteRes.ok && isPullRateLimited(athleteRes.status)) return false;
      athlete = athleteRes.ok ? athleteRes.json : null;
      const zonesRes = await stravaGet("/athlete/zones", token, budget);
      if (!zonesRes.ok && isPullRateLimited(zonesRes.status)) return false;
      zones = zonesRes.ok ? zonesRes.json : null;
      snapshotsLoaded = true;
      return true;
    }

    // Page oldest-first via `after`; stop on a short page.
    for (let page = 1; ; page++) {
      const listRes = await stravaGet(
        `/athlete/activities?after=${after}&page=${page}&per_page=${PER_PAGE}`,
        token,
        budget
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
        const externalId = `${STRAVA_ID}:${summary.id}`;
        const sportType = String(summary.sport_type ?? summary.type ?? "");
        const cycling = [
          "Ride",
          "GravelRide",
          "MountainBikeRide",
          "EBikeRide",
          "VirtualRide",
        ].includes(sportType);
        const imported = hasImportedStravaActivity(profileId, externalId);
        const hasStreams =
          cycling && hasCyclingStreamDetails(profileId, externalId, STRAVA_ID);
        const startSec = Math.floor(
          new Date(String(summary.start_date)).getTime() / 1000
        );
        // The trailing window exists to FIND late uploads, not to re-download the
        // same immutable detail and stream payloads every hour. A known row is done
        // unless it is a cycling activity whose telemetry is still absent/empty.
        if (imported && (!cycling || hasStreams)) {
          raw.push(summary);
          // The trailing rescan must still carry late Strava edits through the
          // ordinary edit-lock-aware upsert. Only skip the expensive detail and
          // stream calls for a row whose supplemental artifacts are complete.
          const mapped = mapStravaActivity(summary, undefined, tz);
          if (!mapped) {
            skipped++;
            continue;
          }
          activities.push(mapped.activity);
          samples.push(...mapped.samples);
          if (mapped.route) routes.push(mapped.route);
          if (Number.isFinite(startSec) && startSec > newestStart) {
            newestStart = startSec;
          }
          continue;
        }
        // Calories come only from the detailed activity. When we can't fetch it —
        // the per-run request cap is reached or Strava rate-limits us — stop BEFORE
        // importing this activity, leaving the cursor behind it so the next run
        // resumes here and imports it WITH calories (rather than storing it
        // calorie-less and advancing past it forever).
        const detailRes = await stravaGet(
          `/activities/${summary.id}`,
          token,
          budget
        );
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
        if (cycling && detailRes.ok) {
          let stream: unknown = null;
          if (!hasStreams) {
            if (!(await loadSnapshots())) {
              truncated = true;
              break;
            }
            const keys = STRAVA_STREAM_KEYS.join(",");
            const streamRes = await stravaGet(
              `/activities/${summary.id}/streams?keys=${keys}&key_by_type=true`,
              token,
              budget
            );
            if (!streamRes.ok && isPullRateLimited(streamRes.status)) {
              truncated = true;
              break;
            }
            stream = streamRes.ok ? streamRes.json : null;
          }
          const artifacts = mapStravaCyclingArtifacts(
            String(summary.id),
            detail,
            stream,
            hasStreams ? null : athlete,
            hasStreams ? null : zones,
            snapshotAt
          );
          cyclingTelemetry.push(artifacts.telemetry);
          activityLaps.push(...artifacts.laps);
          segmentEfforts.push(...artifacts.segmentEfforts);
          if (detailRes.ok) {
            detailArtifactParents.push(mapped.activity.external_id);
          }
        }
        activities.push(mapped.activity);
        samples.push(...mapped.samples);
        if (mapped.route) routes.push(mapped.route);
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
        cyclingArtifactParents: detailArtifactParents,
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

interface StravaBackfillCandidate {
  external_id: string;
  type: string;
  title: string;
  components: string | null;
}

function stravaBackfillCandidates(
  profileId: number
): StravaBackfillCandidate[] {
  const rows = db
    .prepare(
      `SELECT a.external_id, a.type, a.title, a.components
         FROM activities a
         LEFT JOIN activity_telemetry t
           ON t.profile_id = a.profile_id
          AND t.activity_id = a.id
          AND t.source = 'strava'
        WHERE a.profile_id = ?
          AND a.source = 'strava'
          AND (t.activity_id IS NULL OR t.streams_json IS NULL OR t.streams_json = '{}')
        ORDER BY a.date DESC, a.start_time DESC, a.id DESC`
    )
    .all(profileId) as StravaBackfillCandidate[];
  return rows.filter(isCyclingActivity);
}

export function countMissingStravaRideDetails(profileId: number): number {
  return stravaBackfillCandidates(profileId).length;
}

export interface StravaBackfillResult {
  backfilled: number;
  failed: number;
  remaining: number;
  requests: number;
  paused: boolean;
  retryAfterAt: string | null;
}

export interface StravaBackfillProgress {
  remaining: number;
  failed: number;
  requests: number;
}

// Fill rich artifacts for Strava rides imported before cycling telemetry existed.
// Successful rows disappear from the candidate query, so every invocation resumes
// naturally and is safe to repeat after a quota pause or transient provider error.
export async function runStravaDetailsBackfill(
  profileId: number,
  onProgress?: (progress: StravaBackfillProgress) => void
): Promise<StravaBackfillResult | { error: string }> {
  const token = await getStravaAccessToken(profileId);
  if (!token) return { error: "not connected" };
  const candidates = stravaBackfillCandidates(profileId);
  if (candidates.length === 0) {
    return {
      backfilled: 0,
      failed: 0,
      remaining: 0,
      requests: 0,
      paused: false,
      retryAfterAt: null,
    };
  }

  const clientId = getStravaConfig(profileId).clientId ?? "unconfigured";
  const budget = createStravaRequestBudget(clientId, maxRequests);
  const snapshotAt = new Date().toISOString();
  let backfilled = 0;
  let failed = 0;
  let paused = false;

  const reportProgress = () =>
    onProgress?.({
      remaining: Math.max(candidates.length - backfilled, 0),
      failed,
      requests: budget.requests,
    });

  const athleteRes = await stravaGet("/athlete", token, budget);
  if (!athleteRes.ok && isPullRateLimited(athleteRes.status)) paused = true;
  const zonesRes = paused
    ? null
    : await stravaGet("/athlete/zones", token, budget);
  if (zonesRes && !zonesRes.ok && isPullRateLimited(zonesRes.status)) {
    paused = true;
  }
  const athlete = athleteRes.ok ? athleteRes.json : null;
  const zones = zonesRes?.ok ? zonesRes.json : null;

  for (const candidate of candidates) {
    if (paused) break;
    const match = /^strava:(\d+)$/.exec(candidate.external_id);
    if (!match) {
      failed++;
      reportProgress();
      continue;
    }
    const providerId = match[1];
    const detailRes = await stravaGet(
      `/activities/${providerId}`,
      token,
      budget
    );
    if (!detailRes.ok) {
      if (isPullRateLimited(detailRes.status)) {
        paused = true;
        break;
      }
      failed++;
      reportProgress();
      continue;
    }
    const keys = STRAVA_STREAM_KEYS.join(",");
    const streamRes = await stravaGet(
      `/activities/${providerId}/streams?keys=${keys}&key_by_type=true`,
      token,
      budget
    );
    if (!streamRes.ok) {
      if (isPullRateLimited(streamRes.status)) {
        paused = true;
        break;
      }
      failed++;
      reportProgress();
      continue;
    }
    const artifacts = mapStravaCyclingArtifacts(
      providerId,
      detailRes.json,
      streamRes.json,
      athlete,
      zones,
      snapshotAt
    );
    const hasStreams = Object.keys(artifacts.telemetry.streams).length > 0;
    writeTx(() => {
      upsertCyclingTelemetry(profileId, [artifacts.telemetry], STRAVA_ID);
      replaceActivityLaps(profileId, artifacts.laps, STRAVA_ID, [
        candidate.external_id,
      ]);
      replaceSegmentEfforts(profileId, artifacts.segmentEfforts, STRAVA_ID, [
        candidate.external_id,
      ]);
    });
    if (hasStreams) backfilled++;
    else failed++;
    reportProgress();
  }

  return {
    backfilled,
    failed,
    remaining: countMissingStravaRideDetails(profileId),
    requests: budget.requests,
    paused,
    retryAfterAt: paused ? budget.retryAfterAt : null,
  };
}
