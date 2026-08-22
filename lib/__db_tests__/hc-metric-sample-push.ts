// ONE HEALTH CONNECT PUSH, THROUGH THE PATH THE INGEST RUNS (#3424).
//
// The overlap-supersede is not inside `upsertMetricSamples`, and it is no longer a plan
// over the payload either. The owner's ruling of 2026-08-22 derives the victim set from
// the STORE, inside the last chunk's `IMMEDIATE` transaction and AFTER that chunk's
// upserts have run:
//
//   C  upsertMetricSamples            the upsert loop — it only stamps
//   B  supersedeMetricSampleOverlaps  the victims, read from the store and deleted
//
// So a test that called `upsertMetricSamples` alone would exercise a mechanism production
// does not have, and would go green on a store the real path would never produce. This
// helper is the composition, in ONE place, shared by every spec that drives a push
// directly.
//
// THE ORDER DRIFT IS NOW STRUCTURALLY IMPOSSIBLE, AND A REVIEW ROUND PAID FOR THAT (#3438).
// This file once ran plan → DELETE → UPSERT while production ran plan → UPSERT → DELETE,
// and its header promised "a spec cannot drift from the ingest" while it did. The fix is
// not a stricter promise: with the plan INSIDE the deleting transaction there is only one
// call to place, and a helper that ran it before the upserts would be reading a store the
// upserts had not touched — which every stamped-row assertion catches immediately. The
// two things this file still has to copy from `ingestHealthConnectPayload` are named
// beside the lines that copy them:
//
//   1. the stamp goes through `pushStampFor`, so a spec cannot mint a stamp production
//      would refuse (it bypassed it, and both spec files were dating their pushes ten
//      days into the future, past the 12h clock bound — every one of those stamps would
//      have been NULL in production, and a NULL stamp supersedes nothing);
//   2. `overlapsLeft` comes back from the supersede itself, read in the transaction that
//      did the deleting, exactly as the ingest reads it.
//
// ONE TRANSACTION, SINGLE CHUNK, deliberately. `writeTx` is `.immediate()` and the real
// path derives and deletes inside the last chunk's, so the helper wraps the pair in one
// too — anything less would let a spec observe a state production never commits. The real
// chunk split lives in `ingestHealthConnectPayload`, and the specs that care about
// chunking and row order (hc-overlap-push-property.test.ts above all) drive THAT.

import { writeTx } from "@/lib/db";
import {
  supersedeMetricSampleOverlaps,
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { pushStampFor } from "@/lib/metric-window-overlap";
import type { UpsertCounts, SyncRowSink } from "@/lib/integrations/sync-log";

export interface MetricSamplePushResult extends UpsertCounts {
  /**
   * The number the ingest turns into its Review line: day buckets still reading high
   * after this push finished — stored rows the predicate declined, plus the excess the
   * push carries against itself.
   *
   * Read from the supersede's own return, the same way `ingestHealthConnectPayload`
   * reads it, so a spec driving this helper cannot pass while the real ingest reports
   * something else.
   */
  overlapsLeft: number;
}

/** Upsert, then supersede — one push, in one transaction, as the last chunk runs it. */
export function pushMetricSamples(
  profileId: number,
  rows: NormMetricSample[],
  source: string,
  sink?: SyncRowSink,
  options: { pushedAt?: string | null } = {}
): MetricSamplePushResult {
  // (1) The stamp the ROUTE would have produced, not the one the caller typed. A stated
  // instant further ahead of this clock than MAX_PUSH_CLOCK_SKEW_MS becomes NULL here
  // exactly as it does in `ingestHealthConnectPayload`.
  const pushedAt = pushStampFor(options.pushedAt);
  return writeTx(() => {
    const counts = upsertMetricSamples(profileId, rows, source, sink, {
      pushedAt,
    });
    const outcome = supersedeMetricSampleOverlaps(profileId, source, pushedAt);
    counts.superseded += outcome.removed;
    // (2) From the query that did the deleting, not from a forecast.
    return { ...counts, overlapsLeft: outcome.overlapsLeft };
  });
}
