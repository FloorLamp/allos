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
  // Day buckets left double counting once this push has FINISHED — set after the chunks
  // commit, not from the plan alone, because the plan is a forecast and the Review line
  // claims to report what happened. See where it is computed below.
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
    // the whole push below, before any of it is written, so neither row order nor the
    // chunk split can reach them (owner ruling on #3424, option 2).
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
    // ── PASS B ── the deletes, ONCE, inside the LAST CHUNK'S transaction.
    //
    // Not a transaction of its own, and NOT the first chunk's — that was this PR's earlier
    // reading of the ruling, and the owner corrected it (#3424, 2026-08-22). The reason
    // was always "a crash between the deletes and the writes must not leave a day reading
    // LOW with nothing in flight to restore it"; first-chunk placement satisfies that only
    // for a ONE-CHUNK push. Split the push and it does the opposite: the deletes commit
    // with chunk 1, chunk 2 fails, and the day reads NOTHING where `main` would still read
    // the old rows.
    //
    // The invariant the placement serves, which is the thing to keep:
    //
    //     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
    //     NEVER NEITHER. A day may read HIGH between commits; it must never read
    //     LOWER than `main` would.
    //
    // So a victim is deleted only in a transaction committing with or after every row that
    // replaces it. One chunk: the same transaction as the rows. Many: chunks 1…n−1 commit
    // upserts only and the store transiently double counts, then the last chunk commits
    // its upserts AND the whole victim set together. A failure in chunk k leaves old +
    // chunks<k — visible, never a hole — and the exporter re-carries the unacked rows on
    // its next push, which pass A re-plans over and collapses.
    //
    // `remaining` is what makes this the last chunk: the slices partition `orderedSamples`,
    // so it reaches 0 exactly once, in the final one. The deletes run AFTER that chunk's
    // upserts, so pass C never reads a store pass B has touched — the pass-A/pass-C
    // invariant holds literally rather than by the twin exclusion alone.
    let remaining = orderedSamples.length;
    // How many victims pass B actually removed — the number `counts.superseded` already
    // reports honestly, kept here because the Review line needs the OTHER half of it.
    let superseded = 0;
    commitChunks(
      orderedSamples,
      (slice, sink) => {
        remaining -= slice.length;
        // ── PASS C ── the upsert loop, with no supersede logic in it at all.
        const part = upsertMetricSamples(profileId, slice, source, sink, {
          pushedAt,
        });
        if (remaining === 0) {
          superseded = applyMetricSampleSupersede(profileId, supersede.victims);
          part.superseded += superseded;
        }
        return part;
      },
      (c) => {
        samples = foldCounts([samples, c]);
      }
    );
    // WHAT THIS PUSH LEFT DOUBLE COUNTING, COMPUTED FROM WHAT HAPPENED (#3438).
    //
    // It used to be summed from the PLAN, before `commitChunks` ran, while the comment at
    // the emit site claimed it covered "every reason a supersede was declined". It did
    // not cover the last one: pass B's `pushed_at IS ?` guard, which declines a victim a
    // concurrent push has re-stamped between pass A's read and the DELETE. That row stays
    // in the table, the day reads high, and the plan-side number had already said zero.
    //
    // THREE TERMS, all of them days reading high, which is the only thing the line
    // claims. `leftStanding` is stored rows the push overlapped and did not collapse.
    // `inPushDoubleCounts` is the excess the push carries against ITSELF — ruling item
    // 3's "a push carrying both anchorings writes both", which leaves a day double
    // counting with no STORED row for `leftStanding` to name. And `victims.length -
    // superseded` is the planned deletes the guard refused: rows still standing, for a
    // reason the plan could not see because it had not happened yet.
    //
    // The three are disjoint by construction: `leftStanding` and `victims` are disjoint
    // sets of stored ids (pass A prunes one from the other), and `inPushDoubleCounts`
    // counts incoming rows rather than stored ones.
    overlapsLeft =
      supersede.leftStanding.length +
      supersede.inPushDoubleCounts +
      (supersede.victims.length - superseded);
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

  // The Review line, appended to the details this push already carries. Summed above
  // from what HAPPENED — the plan's two halves plus the victims pass B's guard declined —
  // so it covers every reason a supersede was declined, including the one the plan cannot
  // know because it has not happened yet.
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
