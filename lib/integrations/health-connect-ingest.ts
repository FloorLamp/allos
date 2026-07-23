import { writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { chunk, INGEST_CHUNK_SIZE } from "@/lib/ingest-bounds";
import { emptyCounts, foldCounts, type UpsertCounts } from "./sync-log";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertHrMinutes,
  upsertMetricSamples,
  upsertVitals,
  type IngestCounts,
} from "./normalize";
import { HEALTH_CONNECT_ID, type ParsedPayload } from "./health-connect";
import { queuePostWorkoutForFreshImports } from "@/lib/notifications/post-workout-imports";

const log = createLogger("health-connect-ingest");

// The chunked write path for a parsed Health Connect batch (issue #1064).
//
// Each record type is processed in bounded slices (INGEST_CHUNK_SIZE), and EACH slice
// is its own IMMEDIATE writeTx — so the single better-sqlite3 connection is never held
// longer than one chunk, which is what makes the generous byte/record caps safe. The
// upserts are idempotent on their natural keys and consult the user-edit lock
// (isEditLocked) and re-import tombstones on a FRESH pre-image read every chunk, so:
//   - a row hand-corrected mid-window is still skipped as `edited` no matter which
//     chunk it lands in (the lock is re-read per chunk, never cached across the batch);
//   - a mid-batch failure rolls back only its own chunk and leaves the prior chunks
//     committed — the next push of the rolling window re-covers the remainder;
//   - the whole push still folds into ONE recordSyncEvent (the #14 split) because the
//     per-chunk UpsertCounts are folded here into one per-type total, NOT recorded
//     per chunk.
// The per-type collapse the upserts do internally (body_metrics same-date merge) stays
// correct: the Health Connect parser emits at most one body-metrics row per date, so a
// date never straddles two chunks.

export interface ChunkedIngestResult {
  counts: IngestCounts;
  split: UpsertCounts;
  // Ids of the vitals rows touched across every chunk, for the post-commit
  // reconcileFlags/canonical-name pass the caller runs after all chunks land.
  vitalIds: number[];
}

const total = (c: UpsertCounts): number => c.inserted + c.updated + c.unchanged;

export function ingestHealthConnectPayload(
  profileId: number,
  parsed: ParsedPayload,
  source: string = HEALTH_CONNECT_ID,
  chunkSize: number = INGEST_CHUNK_SIZE
): ChunkedIngestResult {
  let bodyMetrics = emptyCounts();
  let samples = emptyCounts();
  let hrMinutes = emptyCounts();
  let activities = emptyCounts();
  let vitals = emptyCounts();
  const vitalIds: number[] = [];

  for (const slice of chunk(parsed.bodyMetrics, chunkSize)) {
    const c = writeTx(() => upsertBodyMetrics(profileId, slice, source));
    bodyMetrics = foldCounts([bodyMetrics, c]);
  }
  for (const slice of chunk(parsed.samples, chunkSize)) {
    const c = writeTx(() => upsertMetricSamples(profileId, slice, source));
    samples = foldCounts([samples, c]);
  }
  for (const slice of chunk(parsed.hrMinutes, chunkSize)) {
    const c = writeTx(() => upsertHrMinutes(profileId, slice, source));
    hrMinutes = foldCounts([hrMinutes, c]);
  }
  for (const slice of chunk(parsed.activities, chunkSize)) {
    const c = writeTx(() => upsertActivities(profileId, slice, source));
    activities = foldCounts([activities, c]);
  }
  // The no-finish fallback for imports (#1154 §B2): a just-ingested session dated
  // today gets the delayed post-workout dose dispatch armed, so its doses aren't
  // bucket-slot-dependent. Only when the ingest actually INSERTED rows.
  //
  // ISOLATED (#1285): every chunk's DB writes already committed above, so a failure in
  // this post-commit arming (e.g. a downstream findings computation throwing) must NOT
  // bubble up and misreport an otherwise-successful ingest batch as a full sync failure.
  // Log it to the error sink and carry on; the next rolling-window push re-arms it.
  if (activities.inserted > 0) {
    try {
      queuePostWorkoutForFreshImports(profileId);
    } catch (err) {
      log.error("post-workout arming failed after Health Connect ingest", {
        profileId,
        err,
      });
    }
  }
  for (const slice of chunk(parsed.vitals, chunkSize)) {
    const r = writeTx(() => upsertVitals(profileId, slice, source));
    vitals = foldCounts([vitals, r.counts]);
    vitalIds.push(...r.ids);
  }

  return {
    counts: {
      bodyMetrics: total(bodyMetrics),
      samples: total(samples),
      hrMinutes: total(hrMinutes),
      activities: total(activities),
      vitals: total(vitals),
    },
    split: foldCounts([bodyMetrics, samples, hrMinutes, activities, vitals]),
    vitalIds,
  };
}
