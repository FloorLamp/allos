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
  collapseRewrittenSleepSessions,
  firstMetricSampleIdOfPush,
  supersedeMetricSampleOverlaps,
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
  sleepOverlapsLeftWarning,
  type ParsedPayload,
} from "./health-connect";
import {
  pushedMeasures,
  reconcileRekeyedBodyMetrics,
} from "./ingest-timezone-reconcile";
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
  // Day buckets left double counting once this push has FINISHED. Read from the store
  // in the last chunk's transaction, by the same query that decides the deletes, so it
  // reports what HAPPENED rather than a forecast. See where it is set below.
  let overlapsLeft = 0;
  // The sleep half of that same number, kept only to decide whether its own sentence is
  // owed (#3628). ONE counter reaches Review; the two symptoms read differently.
  let sleepOverlapsLeft = 0;
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
    // Every (date, measure) THIS PUSH writes, computed once over the whole push — the
    // reconcile below must never null a measure a sibling chunk has already landed, and
    // the chunk it is running in cannot see the others.
    const bodyMetricPairs = pushedMeasures(parsed.bodyMetrics);
    commitChunks(
      parsed.bodyMetrics,
      (slice, sink) => {
        // #3524: the profile's timezone may have moved since these readings were last
        // pushed, and `body_metrics.date` is the profile-local day computed at INGEST —
        // so the same instant now files on a different day and #608's duplicate appears.
        // Withdraw the old key of each measure this push re-keyed, in the same
        // transaction as the write that replaces it. Deliberately AFTER the upsert: the
        // reconcile's own rule is that a measure's old key is withdrawn only if the
        // measure LANDED under the new one, and only the write can answer that.
        const counts = upsertBodyMetrics(profileId, slice, source, sink);
        reconcileRekeyedBodyMetrics(profileId, slice, source, {
          pushed: bodyMetricPairs,
        });
        return counts;
      },
      (c) => {
        bodyMetrics = foldCounts([bodyMetrics, c]);
      }
    );
    // ASCENDING started_at BEFORE THE CHUNK SPLIT — deterministic write order only.
    // `upsertMetricSamples` orders what it is GIVEN and only ever sees one chunk, so
    // sorting here is what makes the per-chunk order a global one. Correctness does not
    // rest on it, and no longer rests on the stamp either: the deletes are planned over
    // the whole push below, before any of it is written, so neither row order nor the
    // chunk split can reach them (owner ruling on #3424, option 2).
    const orderedSamples = [...parsed.samples].sort((a, b) =>
      compareWindowStarts(a.started_at, b.started_at)
    );
    // ONE stamp for the whole push — what the exporter stated, bounded against a
    // device clock that claims the future. Null when the push states nothing readable,
    // and then this push supersedes nothing at all.
    const pushedAt = pushStampFor(parsed.pushedAt);
    // THE ID WATERMARK, READ BEFORE THE FIRST SAMPLE LANDS (#3628). A row at or above it
    // is one this push inserted; a row below it predates the push. It is what tells a
    // corrected sleep session from the mis-zoned first write it corrects, because the
    // exporter re-sends that first write for 48 h and the re-send moves its `pushed_at`.
    const firstSampleId = firstMetricSampleIdOfPush(profileId);
    // ── THE SUPERSEDE (#3424) ── DERIVED FROM THE STORE, IN THE LAST CHUNK.
    //
    // There is no plan over the payload any more, and its absence is the fix (the owner's
    // ruling of 2026-08-22T13:46Z). A read-only pass over the push, however carefully
    // written, reads its facts at one moment and acts on them at another — and rounds 7,
    // 8 and 9 all walked through that gap, whether the fact was one the plan never asked
    // (a #508 tombstone refusing the replacement) or one a concurrent writer moved (a
    // Data → Manage delete, a per-row Edit arming `edited` on the victim).
    //
    // So the victim set is derived from THE STORE, inside the LAST chunk's `IMMEDIATE`
    // transaction and AFTER that chunk's upserts have run: a stored day bucket is a
    // victim exactly when a row of its own group carrying THIS PUSH'S STAMP is FILED
    // UNDER THE VICTIM'S OWN `date`, overlaps it and outranks it, unlocked. A row a veto
    // stopped never got the stamp, so it justifies nothing — every veto is honoured
    // without being named, and a fifth one costs no edit here.
    //
    // THE `date` TERM IS THE COVER-THE-DAY RULING (#3424, 2026-08-23T00:58Z), and it is
    // what stops the PREVIOUS day's re-anchored bucket — which overlaps this day's row
    // by the zone offset — from justifying a delete on a day this push never replaced.
    // The day is the unit a person reads, and no date may lose its last reading to this
    // mechanism. `supersedeMetricSampleOverlaps` carries the argument.
    //
    // THE PLACEMENT IS THE OTHER RULING (#3424, 2026-08-22T05:46Z), and it is the LAST
    // chunk rather than the first:
    //
    //     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
    //     NEVER NEITHER. A day may read HIGH between commits; it must never read
    //     LOWER than `main` would.
    //
    // One chunk: the deletes and the rows are in the same transaction. Many: chunks
    // 1…n−1 commit upserts only and the store transiently double counts, then the last
    // chunk commits its upserts AND the victim set together. A failure in chunk k leaves
    // old + chunks<k — visible, never a hole — and the exporter re-carries the unacked
    // rows on its next push, which re-derives over that store and collapses it. Rows
    // landed by chunks 1…n−1 carry the stamp and are committed, so the final transaction
    // sees the whole push.
    //
    // `remaining` is what makes this the last chunk: the slices partition
    // `orderedSamples`, so it reaches 0 exactly once, in the final one.
    let remaining = orderedSamples.length;
    commitChunks(
      orderedSamples,
      (slice, sink) => {
        remaining -= slice.length;
        // The upsert loop, with no supersede logic in it at all — it only stamps.
        const part = upsertMetricSamples(profileId, slice, source, sink, {
          pushedAt,
        });
        if (remaining === 0) {
          const outcome = supersedeMetricSampleOverlaps(
            profileId,
            source,
            pushedAt
          );
          part.superseded += outcome.removed;
          // The re-timed sleep session (#3628), in this same transaction and after the
          // same upserts. A different question from the day-bucket supersede above — a
          // point event the source RE-TIMED rather than a span it re-cut — so it is a
          // separate rule, and it needs no stamp: arrival order is the id watermark.
          const sleep = collapseRewrittenSleepSessions(
            profileId,
            source,
            firstSampleId
          );
          part.superseded += sleep.removed;
          // WHAT THIS PUSH LEFT DOUBLE COUNTING, from the same query that did the
          // deleting: the candidates the predicate declined (locked, not outranked,
          // cut at sub-daily granularity) plus the excess the push carries against
          // ITSELF. Read inside the transaction that acted, so it describes what
          // happened rather than what was forecast.
          overlapsLeft = outcome.overlapsLeft + sleep.overlapsLeft;
          sleepOverlapsLeft = sleep.overlapsLeft;
        }
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

  // The Review lines, appended to the details this push already carries. Both counts are
  // read above from the store, inside the transaction that did the deleting, so they name
  // what is still duplicated once this push is on disk.
  //
  // TWO SENTENCES, ONE NUMBER (#3628). The day-bucket residue and the sleep residue are
  // the same kind of fact — something this push could not collapse — so they are counted
  // together and reported as one Review number. They are not the same SYMPTOM: a day
  // bucket left standing makes a day's total read HIGH, and a sleep session left standing
  // puts a second night on the Sleep page, in SRI and in the stage totals. Each sentence
  // therefore names only the rows it is actually about, which is also why the day-bucket
  // count is net of the sleep half rather than the sum — the older wording claimed those
  // rows made a day "count some activity twice", which is not true of a night.
  if (overlapsLeft > sleepOverlapsLeft) {
    parsed.details.warnings.push(
      overlapsLeftWarning(overlapsLeft - sleepOverlapsLeft)
    );
  }
  if (sleepOverlapsLeft > 0) {
    parsed.details.warnings.push(sleepOverlapsLeftWarning(sleepOverlapsLeft));
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
