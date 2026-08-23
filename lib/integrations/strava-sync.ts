import { createLogger } from "@/lib/log";
import { userErrorCopy } from "@/lib/user-error-copy";
import { utcInstant } from "@/lib/date";
import { db, writeTx } from "@/lib/db";
import { getTimezone } from "@/lib/settings";
import {
  STRAVA_ID,
  getStravaAccessToken,
  getStravaConfig,
  getStravaCursor,
  setStravaCursor,
} from "./connections";
import { mapStravaActivity, mapStravaActivityArtifacts } from "./strava";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { pullPaging } from "./registry";
import { isPullRateLimited, DAY_SECONDS } from "./pull-window";
import { runPullSync, type PullOutcome, type PullSpec } from "./pull-sync";
import { syncFailureCopy } from "./sync-failure-copy";
import type {
  NormActivity,
  NormActivityRoute,
  NormMetricSample,
} from "./normalize";
import {
  hasTelemetryAnswer,
  replaceActivityLaps,
  replaceSegmentEfforts,
  STRAVA_STREAM_KEYS,
  upsertActivityTelemetry,
  type NormActivityLap,
  type NormActivityTelemetry,
  type NormSegmentEffort,
} from "./activity-telemetry";
import {
  createStravaRequestBudget,
  type StravaRequestBudget,
} from "./strava-rate-limit";
import { backfillFetchVerdict } from "./backfill-outcome";
import { parseJsonPreservingIds } from "./json-big-ids";

// Whether a failed `/streams` response settles the question for THIS activity in
// the AUTOMATIC sync, where the answer is persisted as an empty telemetry row and
// never asked again.
//
// Deliberately narrower than `backfillFetchVerdict`, which the user-triggered
// backfill uses: that one calls 403 unavailable, and 403 is documented there as
// "a private activity, OR a token without activity:read_all" — the second of
// which is a CONNECTION fact, not a fact about this activity. The backfill can
// afford it because it recomputes on every run and a person chose to re-ask; a
// persisted marker cannot. A profile connected without the read-all scope would
// otherwise bank an empty row for every recorded session, and re-authorizing
// would never fetch them — while their pages claimed the source "recorded totals
// only", which would be false.
//
// So the sync settles ONLY on the two per-resource tombstones: 404 (Strava also
// answers this for an activity with no recorded streams at all) and 410.
function streamFinallyAbsent(status: number): boolean {
  return status === 404 || status === 410;
}

// Strava's half of the shared pull runner (#2040): the list+detail request pair, the
// `page`/`per_page` pagination, and row mapping. Everything either side of that —
// timeout and call bounds, the rate-limit → truncate rule, the transaction, the
// cursor decision, and the sync-event accounting — belongs to
// lib/integrations/pull-sync.ts and lib/integrations/pull-window.ts, shared with Oura
// and Withings.

const log = createLogger("strava-sync");

// What this source is DOING and WHO it reaches, declared once (#3618) — spent by both
// failure doors, the throw branch through `userErrorCopy` and the failing-status
// branch through `syncFailureCopy`.
const STRAVA_FAILURE = {
  doing: "sync your Strava activities",
  service: "Strava",
} as const;

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
    // NOT `res.json()`. Strava's effort and lap ids are int64 (~3.5e18) and a
    // double cannot hold them, so an ordinary parse rounds every one of them
    // before this app ever sees it (#3194). The ids are preserved in the response
    // TEXT and reach the mapper as exact digit strings; see json-big-ids.ts.
    return { ok: true, json: parseJsonPreservingIds(await res.text()) };
  } catch (err) {
    // A network THROW (DNS failure, ECONNRESET, TLS error, or the timeout above)
    // rejects `fetch`. Convert it to a non-ok result — the same shape Withings'
    // withingsPost returns (issue #476) — so the runner records an ok:false sync
    // event instead of letting the rejection escape unlogged, which left Review green
    // while Strava had silently stopped syncing. status 0 marks "no HTTP response".
    //
    // THE CAUSE SPLITS IN TWO (#3592). It used to travel on `error` as raw caught
    // text and end up rendered — "Strava activities request failed: ECONNRESET" on
    // the integration card. WHICH request failed is what an operator reads, so the
    // path goes to `log.error` with the raw cause; `error` carries the house sentence
    // the card and the "Sync now" toast show a person.
    log.error("Strava request failed", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 0,
      error: userErrorCopy(err, STRAVA_FAILURE),
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
    const activityTelemetry: NormActivityTelemetry[] = [];
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
    const snapshotAt = utcInstant();
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
        // status 0 = a network throw/timeout caught in stravaGet, which already
        // logged the path and the real cause and put HOUSE COPY on `error` (#3592).
        // It is passed through unprefixed: prefixing it would rebuild the raw-text
        // sentence this change removed.
        //
        // A FAILING STATUS now takes the status-keyed house sentence too (#3618) —
        // this line used to read "Strava activities request failed (401)". The
        // status is for an operator and goes to the log.
        if (!listRes.error) {
          log.error("Strava request failed", {
            path: "/athlete/activities",
            status: listRes.status,
          });
        }
        return {
          error:
            listRes.error ?? syncFailureCopy(listRes.status, STRAVA_FAILURE),
        };
      }
      const list = Array.isArray(listRes.json)
        ? (listRes.json as Record<string, unknown>[])
        : [];
      if (list.length === 0) break;

      for (const summary of list) {
        const externalId = `${STRAVA_ID}:${summary.id}`;
        // Streams are asked for by RECORDING, not by sport (#2870 step 4).
        // `activity_telemetry` was schema-generic from the start, but the fetch
        // was gated to a five-entry cycling allowlist — so a run or a walk from
        // the same watch, carrying the same heart-rate and pace series, stored
        // nothing. What actually decides whether a stream exists is whether a
        // device recorded the session: Strava's own `manual` flag marks the
        // hand-entered ones, and asking about those costs a request to learn
        // "nothing" every time.
        const recorded = summary.manual !== true;
        const answered =
          recorded && hasTelemetryAnswer(profileId, externalId, STRAVA_ID);
        const startSec = Math.floor(
          new Date(String(summary.start_date)).getTime() / 1000
        );
        const imported = hasImportedStravaActivity(profileId, externalId);
        // The trailing window exists to FIND late uploads, not to re-download the
        // same immutable detail and stream payloads every hour. A known row is done
        // unless the source might still have streams we have never asked for.
        if (imported && (!recorded || answered)) {
          raw.push(summary);
          // A HAND-ENTERED session is answered without asking — `manual: true` IS
          // the source saying it has no telemetry — so record that answer here,
          // at zero requests (#3037). Without this the fast path skips the
          // session before any write, it never gains a telemetry row, and it
          // matches the backfill candidate predicate forever: the badge cannot
          // reach zero and each run spends two requests re-learning nothing.
          // Idempotent — once the answer is stored the upsert is a no-op.
          if (!recorded) {
            activityTelemetry.push({
              external_id: externalId,
              streams: {},
              ftp_w: null,
              heart_rate_zones: null,
              power_zones: null,
              snapshot_at: snapshotAt,
            });
          }
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
        // Keep the raw source JSON for the raw viewer, whether or not it maps.
        raw.push(detail ?? summary);

        const mapped = mapStravaActivity(summary, detail, tz);
        if (!mapped) {
          skipped++;
          continue;
        }
        if (detailRes.ok) {
          let stream: unknown = null;
          // Whether the source has now SAID what it holds for this activity. A
          // hand-entered one is answered without asking; a 200 (streams or an
          // empty payload) and a 403/404/410 are both final. A transient
          // failure is NOT — recording an empty row for it would settle the
          // question against a server hiccup, and the automatic sync would
          // never ask again.
          let answeredNow = !recorded;
          if (recorded && !answered) {
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
            answeredNow = streamRes.ok || streamFinallyAbsent(streamRes.status);
            stream = streamRes.ok ? streamRes.json : null;
          }
          const artifacts = mapStravaActivityArtifacts(
            String(summary.id),
            detail,
            stream,
            answered ? null : athlete,
            answered ? null : zones,
            snapshotAt
          );
          // Laps and efforts ride on the DETAIL, so they land whenever it does.
          // Telemetry lands only on a settled answer, so "we have a row" keeps
          // meaning "the source has told us", which is what stops the hourly
          // re-ask without abandoning a row over a 500.
          if (answeredNow || answered)
            activityTelemetry.push(artifacts.telemetry);
          activityLaps.push(...artifacts.laps);
          segmentEfforts.push(...artifacts.segmentEfforts);
          detailArtifactParents.push(mapped.activity.external_id);
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
        activityTelemetry,
        activityLaps,
        segmentEfforts,
        telemetryArtifactParents: detailArtifactParents,
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
  // Every Strava session, not just the rides (#2870 step 4) — but only the ones
  // the source has NOT ANSWERED for (#3037, owner ruling 2026-08-16).
  //
  // The predicate used to match any empty `streams_json`, which a HAND-ENTERED
  // session matches forever: the source has nothing to give and says so on every
  // ask. So `countMissingStravaSessionDetails` reported 400 on a profile with 400
  // of them, the badge could never reach zero, and each user-triggered run spent
  // two requests per session re-learning "nothing" — ~800 against Strava's
  // 1000/day read ceiling. `activity_telemetry.answer` is what the source said, so
  // this can now ask the question it always meant: has anyone asked yet?
  //
  // A row with `answer IS NULL` and no streams is a session written BEFORE that
  // column existed. It is deliberately still a candidate: pre-#3034 the sync wrote
  // an empty row on a transient failure and on a 403, so an empty row is not
  // evidence of an answer. Those get asked once more under the corrected rules and
  // classify themselves, then leave the set for good.
  //
  // Reversibility is not lost, it moves — a session answered `none` is re-asked
  // when a PERSON asks for it (`recheckStravaAnsweredSessions`), which is exactly
  // the condition backfill-outcome.ts says makes the re-ask affordable.
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
          AND (t.activity_id IS NULL
               OR (t.answer IS NULL
                   AND (t.streams_json IS NULL OR t.streams_json = '{}')))
        ORDER BY a.date DESC, a.start_time DESC, a.id DESC`
    )
    .all(profileId) as StravaBackfillCandidate[];
  return rows;
}

export function countMissingStravaSessionDetails(profileId: number): number {
  return stravaBackfillCandidates(profileId).length;
}

// Sessions the source has already answered `none` for — hand-entered, indoor, or
// with no recorded streams. Not candidates; the count exists so the page can offer
// the re-check below only when there is something to re-check.
export function countAnsweredNoneStravaSessions(profileId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM activity_telemetry t
         JOIN activities a
           ON a.id = t.activity_id AND a.profile_id = t.profile_id
        WHERE t.profile_id = ? AND t.source = 'strava' AND t.answer = 'none'`
    )
    .get(profileId) as { n: number };
  return row.n;
}

// THE EXPLICIT RE-ASK (#3037). `backfill-outcome.ts` argues at length against a
// persisted give-up marker, because re-asking is what recovers a ride made public
// again, a token re-authorized with `activity:read_all`, or an upload the source
// has since finished processing. The owner's ruling keeps that property and pays
// for it deliberately instead of on every run: forgetting the stored `none` puts
// those sessions back in the candidate set, and a person decides when.
//
// It forgets ONLY `none`. An answered-with-streams session is not re-asked — there
// is nothing to recover — and a NULL answer is already a candidate.
export function recheckStravaAnsweredSessions(profileId: number): number {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE activity_telemetry
              SET answer = NULL
            WHERE profile_id = ? AND source = 'strava' AND answer = 'none'`
        )
        .run(profileId).changes
  );
}

export interface StravaBackfillResult {
  backfilled: number;
  failed: number;
  // Candidates Strava gave a FINAL answer for this run: refused (404/403/410) or
  // answered with no streams at all. They are excluded from `remaining` so the job
  // can finish (#2196) — see lib/integrations/backfill-outcome.ts for why no marker
  // is stored.
  unavailable: number;
  remaining: number;
  requests: number;
  paused: boolean;
  retryAfterAt: string | null;
}

export interface StravaBackfillProgress {
  remaining: number;
  failed: number;
  unavailable: number;
  requests: number;
}

// Fill rich artifacts for Strava sessions imported before their streams were
// fetched — the rides that predate cycling telemetry, and (since #2870 step 4)
// every run, walk, and worn session the old cycling allowlist never asked about.
// Successful rows disappear from the candidate query, so every invocation resumes
// naturally and is safe to repeat after a quota pause or transient source error.
//
// A candidate Strava can never answer for does NOT disappear from that query — a
// deleted/private ride is never stored, and a ride with no telemetry stores an empty
// `streams_json` the predicate still matches. Those are counted as `unavailable` and
// subtracted from `remaining`, which is what lets the job reach `completed` while
// leaving the row visible to a later retry (#2196).
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
      unavailable: 0,
      remaining: 0,
      requests: 0,
      paused: false,
      retryAfterAt: null,
    };
  }

  const clientId = getStravaConfig(profileId).clientId ?? "unconfigured";
  const budget = createStravaRequestBudget(clientId, maxRequests);
  const snapshotAt = utcInstant();
  let backfilled = 0;
  let failed = 0;
  let unavailable = 0;
  let paused = false;

  // An unavailable candidate is DONE for progress purposes even though it stays in
  // the candidate query — otherwise the bar stalls one short of full for the rest of
  // the run and the ETA divides by a remainder that never shrinks.
  const reportProgress = () =>
    onProgress?.({
      remaining: Math.max(candidates.length - backfilled - unavailable, 0),
      failed,
      unavailable,
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
      // No Strava id to ask about. Nothing a retry can change, so this is a final
      // answer rather than a failure to be reattempted forever.
      unavailable++;
      reportProgress();
      continue;
    }
    // Strava's own activity id, not an integration source id (#2487).
    const stravaActivityId = match[1];
    const detailRes = await stravaGet(
      `/activities/${stravaActivityId}`,
      token,
      budget
    );
    if (!detailRes.ok) {
      if (isPullRateLimited(detailRes.status)) {
        paused = true;
        break;
      }
      if (backfillFetchVerdict(detailRes.status) === "unavailable")
        unavailable++;
      else failed++;
      reportProgress();
      continue;
    }
    const keys = STRAVA_STREAM_KEYS.join(",");
    const streamRes = await stravaGet(
      `/activities/${stravaActivityId}/streams?keys=${keys}&key_by_type=true`,
      token,
      budget
    );
    if (!streamRes.ok) {
      if (isPullRateLimited(streamRes.status)) {
        paused = true;
        break;
      }
      // Strava answers 404 here for an activity that simply has no recorded streams,
      // which is the same final answer as a deleted one — see backfill-outcome.ts.
      if (backfillFetchVerdict(streamRes.status) === "unavailable")
        unavailable++;
      else failed++;
      reportProgress();
      continue;
    }
    const artifacts = mapStravaActivityArtifacts(
      stravaActivityId,
      detailRes.json,
      streamRes.json,
      athlete,
      zones,
      snapshotAt
    );
    const hasStreams = Object.keys(artifacts.telemetry.streams).length > 0;
    // PER-CANDIDATE CONTAINMENT (#3194). A 208-ride sweep must never be hostage to
    // ride 49: this write used to run bare, so one payload SQLite refused aborted
    // the whole job, left the remaining ~160 rides unfetched, and did it again on
    // every retry because the candidate order is stable. The ride is counted into
    // `failed` — visible on the card, still a candidate next run — and the sweep
    // carries on. The raw cause goes to the operator log, never to the card
    // (#3198).
    try {
      writeTx(() => {
        upsertActivityTelemetry(profileId, [artifacts.telemetry], STRAVA_ID);
        replaceActivityLaps(profileId, artifacts.laps, STRAVA_ID, [
          candidate.external_id,
        ]);
        replaceSegmentEfforts(profileId, artifacts.segmentEfforts, STRAVA_ID, [
          candidate.external_id,
        ]);
      });
    } catch (err) {
      log.error("strava backfill write failed for one candidate", {
        profileId,
        externalId: candidate.external_id,
        err: String(err),
      });
      failed++;
      reportProgress();
      continue;
    }
    if (hasStreams) backfilled++;
    // Both calls returned 200 and the ride still carries no telemetry — an indoor or
    // manually-entered ride. This used to count as a failure, so the row matched the
    // candidate predicate (`streams_json = '{}'`) again on every run, at two 200-OK
    // requests a time, and no HTTP-status rule would ever have caught it (#2196).
    else unavailable++;
    reportProgress();
  }

  return {
    backfilled,
    failed,
    unavailable,
    // The candidate query cannot express "gave up", so the unavailable rows are still
    // in this count. Subtract what this run resolved: `remaining` means "still worth
    // asking about", which is the question `done` is asking.
    remaining: Math.max(
      countMissingStravaSessionDetails(profileId) - unavailable,
      0
    ),
    requests: budget.requests,
    paused,
    retryAfterAt: paused ? budget.retryAfterAt : null,
  };
}
