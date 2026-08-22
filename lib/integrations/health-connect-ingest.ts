import { writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { chunk, INGEST_CHUNK_SIZE } from "@/lib/ingest-bounds";
import { compareWindowStarts, pushStampFor } from "@/lib/metric-window-overlap";
import {
  emptyCounts,
  foldCounts,
  type UpsertCounts,
  type ProvenanceEntry,
} from "./sync-log";
import {
  applyMetricSampleSupersede,
  planMetricSampleSupersede,
  upsertActivities,
  upsertBodyMetrics,
  upsertHrMinutes,
  upsertMetricSamples,
  upsertVitals,
  type IngestCounts,
} from "./normalize";
import {
  HEALTH_CONNECT_ID,
  overlapsLeftWarning,
  type ParsedPayload,
} from "./health-connect";
import { observeStreamFrontiers } from "@/lib/stream-frontier-db";
import { queuePostWorkoutForFreshImports } from "@/lib/notifications/post-workout-imports";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";

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
//     per chunk;
//   - a mid-batch failure throws HealthConnectWriteError carrying the split and the
//     provenance of the chunks that COMMITTED (#1614), so the route's single ok:false
//     event can say what landed instead of reporting null counts over durable rows.
// The per-type collapse the upserts do internally (body_metrics same-date merge) stays
// correct: the Health Connect parser emits at most one body-metrics row per date, so a
// date never straddles two chunks.

export interface ChunkedIngestResult {
  counts: IngestCounts;
  split: UpsertCounts;
  // Ids of the vitals rows touched across every chunk, for the post-commit
  // reconcileFlags/canonical-name pass the caller runs after all chunks land.
  vitalIds: number[];
  // Per-row provenance (#1333) accumulated across every chunk — the caller links it
  // to the sync event id after recordSyncEvent (which needs the whole push's split).
  provenance: ProvenanceEntry[];
}

// A mid-batch write failure that carries the accounting for the chunks that ACTUALLY
// COMMITTED (issue #1614). Earlier chunk transactions are durable by design, so a
// failure event recording null counts and no provenance let rows land while the event
// could not say what landed. This mirrors FitbitTakeoutWriteError: the partial split
// and the committed rows' provenance travel with the error, and the route records ONE
// honest ok:false event from them (the route owns the window / raw payload ref, so it
// stays the event writer).
export class HealthConnectWriteError extends Error {
  readonly committed: ChunkedIngestResult;

  constructor(cause: unknown, committed: ChunkedIngestResult) {
    super("Health Connect ingest failed while writing records", { cause });
    this.name = "HealthConnectWriteError";
    this.committed = committed;
  }
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
  // Stored day buckets the supersede plan declined to collapse — set once from the plan,
  // not accumulated per chunk, because the plan already saw the whole push.
  // Surfaced as a Review line below rather than left for someone to notice in a total.
  let overlapsLeft = 0;
  const vitalIds: number[] = [];
  // Per-row provenance (#1333) accumulated across every chunk. The upserts append the
  // inserted/updated rows they persist; the id captured is committed by the chunk's
  // writeTx, so it's a stable target for the drill-in links.
  const provenance: ProvenanceEntry[] = [];

  // The result as it stands RIGHT NOW — only committed chunks are folded in, so this
  // is exactly what a partial-failure event may claim.
  const snapshot = (): ChunkedIngestResult => ({
    counts: {
      bodyMetrics: total(bodyMetrics),
      samples: total(samples),
      hrMinutes: total(hrMinutes),
      activities: total(activities),
      vitals: total(vitals),
    },
    split: foldCounts([bodyMetrics, samples, hrMinutes, activities, vitals]),
    vitalIds,
    provenance,
  });

  // Keep provenance TRANSACTIONAL with its chunk (#1614, the #1617 pattern): the
  // upserts append to a chunk-local sink while the transaction is open, and only a
  // committed chunk's entries are promoted into the run's array. A rolled-back chunk
  // discards its sink instead of leaking nonexistent row ids into the failure event.
  const commitChunks = <T>(
    rows: readonly T[],
    upsert: (slice: T[], sink: ProvenanceEntry[]) => UpsertCounts,
    fold: (part: UpsertCounts) => void
  ) => {
    for (const slice of chunk(rows, chunkSize)) {
      const sink: ProvenanceEntry[] = [];
      const part = writeTx(() => upsert(slice, sink));
      fold(part);
      provenance.push(...sink);
    }
  };

  try {
    commitChunks(
      parsed.bodyMetrics,
      (slice, sink) => upsertBodyMetrics(profileId, slice, source, sink),
      (c) => {
        bodyMetrics = foldCounts([bodyMetrics, c]);
      }
    );
    // ASCENDING started_at BEFORE THE CHUNK SPLIT — deterministic write order only.
    // `upsertMetricSamples` orders what it is GIVEN and only ever sees one chunk, so
    // sorting here is what makes the per-chunk order a global one. Correctness does not
    // rest on it, and no longer rests on the stamp either: the deletes are planned over
    // the whole push below and applied before any of it is written, so neither row order
    // nor the chunk split can reach them (owner ruling on #3424, option 2).
    const orderedSamples = [...parsed.samples].sort((a, b) =>
      compareWindowStarts(a.started_at, b.started_at)
    );
    // ONE stamp for the whole push — what the exporter stated, bounded against a
    // device clock that claims the future. Null when the push states nothing readable,
    // and then this push supersedes nothing at all.
    const pushedAt = pushStampFor(parsed.pushedAt);
    // ── PASS A (#3424) ── BEFORE `chunk()`, AND THAT IS THE WHOLE POINT.
    //
    // What this push does to the stored rows, decided ONCE, read-only, over the WHOLE
    // push and the store as it stands before any of it is written. It is a pure function
    // of (pre-push store, push): it cannot see a row this push has written, because none
    // has been, and it cannot see a chunk boundary, because it runs before there are any.
    // That is what makes `final store = (pre-store − victims) ⊕ upserts` true by
    // construction rather than by enumerating the channels that could break it — two of
    // which were found by adversarial review after being argued unreachable.
    const supersede = planMetricSampleSupersede(
      profileId,
      orderedSamples,
      source,
      { pushedAt }
    );
    // Overlapping day buckets the plan declined to collapse. Known before the first
    // write, since the plan already knows everything the store can tell it.
    overlapsLeft = supersede.leftStanding.length;
    // ── PASS B ── the deletes, ONCE, inside the FIRST CHUNK'S transaction.
    //
    // Not a transaction of its own: a crash between the deletes and the writes must not
    // leave a day reading LOW with nothing in flight to restore it. The deletes and the
    // first rows of the push commit or roll back together. `pending` is what makes this
    // the first chunk only — every later chunk sees it already spent.
    let pending: readonly number[] | null = supersede.victims;
    commitChunks(
      orderedSamples,
      (slice, sink) => {
        const removed = pending
          ? applyMetricSampleSupersede(profileId, pending)
          : 0;
        pending = null;
        // ── PASS C ── the upsert loop, with no supersede logic in it at all.
        const part = upsertMetricSamples(profileId, slice, source, sink, {
          pushedAt,
        });
        part.superseded += removed;
        return part;
      },
      (c) => {
        samples = foldCounts([samples, c]);
      }
    );
    commitChunks(
      parsed.hrMinutes,
      (slice) => upsertHrMinutes(profileId, slice, source),
      (c) => {
        hrMinutes = foldCounts([hrMinutes, c]);
      }
    );
    commitChunks(
      parsed.activities,
      (slice, sink) => upsertActivities(profileId, slice, source, sink),
      (c) => {
        activities = foldCounts([activities, c]);
      }
    );
  } catch (err) {
    throw new HealthConnectWriteError(err, snapshot());
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
    // High-confidence auto-merge (#1081): a freshly-inserted HC activity that overlaps
    // a Strava/manual row for the same session collapses immediately (through the same
    // core + tombstone + decision path), so the duplicate never reaches Review. Runs
    // AFTER every chunk committed, in its own transactions; ISOLATED like the arming
    // above so a merge failure can't misreport an otherwise-successful ingest.
    try {
      autoMergeActivityDuplicates(profileId);
    } catch (err) {
      log.error("auto-merge failed after Health Connect ingest", {
        profileId,
        err,
      });
    }
  }
  try {
    for (const slice of chunk(parsed.vitals, chunkSize)) {
      const sink: ProvenanceEntry[] = [];
      const r = writeTx(() => upsertVitals(profileId, slice, source, sink));
      vitals = foldCounts([vitals, r.counts]);
      vitalIds.push(...r.ids);
      provenance.push(...sink);
    }
  } catch (err) {
    throw new HealthConnectWriteError(err, snapshot());
  }

  // THE FRONTIER OBSERVATION (#2341). Every declared continuous stream is asked, on
  // every SUCCESSFUL push, whether this push moved it — and the answer is stored.
  //
  // It runs UNCONDITIONALLY, not under `if (parsed.hrMinutes.length)`: a push that
  // carried nothing for the stream is the entire signal. A watch on a charger produces
  // no heart-rate minutes, so its owner's phone keeps pushing batches with zero of
  // them, and it is that repetition — not elapsed clock, which on this pipeline is
  // 30–61 minutes of ingest lag plus whatever the wrist did — that says the source
  // stopped producing.
  //
  // Placed AFTER every chunk committed and BEFORE the return, so it describes exactly
  // what this push left on disk; it is skipped entirely on the throw paths above,
  // because a failed push is not a successful sync that landed without new data. Its
  // own transaction reads the frontier it records — see lib/stream-frontier-db.ts.
  //
  // ISOLATED like the post-commit work above (#1285): the rows are durable and the
  // accounting is settled, so a failure here must not misreport an otherwise-successful
  // batch. A missed observation costs one push of evidence; the next push re-observes.
  try {
    observeStreamFrontiers(profileId, source);
  } catch (err) {
    log.error(
      "stream frontier observation failed after Health Connect ingest",
      {
        profileId,
        err,
      }
    );
  }

  // The Review line, appended to the details this push already carries. Emitted from
  // what HAPPENED, so it covers every reason a supersede was declined.
  if (overlapsLeft > 0) {
    parsed.details.warnings.push(overlapsLeftWarning(overlapsLeft));
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
    provenance,
  };
}
