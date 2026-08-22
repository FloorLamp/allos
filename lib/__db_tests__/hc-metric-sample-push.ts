// ONE HEALTH CONNECT PUSH, THROUGH THE THREE PASSES THE INGEST RUNS (#3424).
//
// The overlap-supersede is not inside `upsertMetricSamples` any more. The owner's ruling
// (option 2 on #3424) splits it in three, because the version that ran per row inside the
// upsert loop deleted rows that a LATER row of the same push then read as its own
// pre-image — a defect two adversarial rounds reached through two different doors:
//
//   A  planMetricSampleSupersede   read-only, over the PRE-PUSH store, over the WHOLE push
//   B  applyMetricSampleSupersede  the deletes, once
//   C  upsertMetricSamples         the upsert loop, with no supersede logic in it
//
// So a test that called `upsertMetricSamples` alone would exercise a mechanism production
// does not have, and would go green on a store the real path would never produce. This
// helper is the composition, in ONE place, shared by every spec that drives a push
// directly.
//
// IT MIRRORS `ingestHealthConnectPayload`, AND A REVIEW ROUND PAID FOR SAYING SO OUT LOUD
// RATHER THAN CLAIMING IT (#3438). The header used to promise "a spec cannot drift from
// the ingest by re-deriving the order itself" while this file ran plan → DELETE → UPSERT
// and production had moved to plan → UPSERT → DELETE — drift in exactly the direction the
// owner's 2026-08-22 correction went, and the one that decides whether pass C can observe
// pass B. The claim is now written as the three things this file must copy, each beside
// the line that copies it:
//
//   1. the stamp goes through `pushStampFor`, so a spec cannot mint a stamp production
//      would refuse (it bypassed it, and both spec files were dating their pushes ten
//      days into the future, past the 12h clock bound — every one of those stamps would
//      have been NULL in production, and a NULL stamp supersedes nothing);
//   2. pass B runs AFTER pass C, in the same call, as it does in the last chunk;
//   3. `overlapsLeft` is summed from what HAPPENED — the plan's two halves plus the
//      victims pass B's `pushed_at IS ?` guard declined — the same way the ingest sums it.
//
// SINGLE CHUNK, deliberately. The real chunk split lives in
// `ingestHealthConnectPayload`, and the specs that care about chunking and row order
// (hc-overlap-push-property.test.ts above all) drive THAT rather than this. What this
// gives a spec is one push against one store, with the passes in the order the ingest
// runs them.

import {
  applyMetricSampleSupersede,
  planMetricSampleSupersede,
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { pushStampFor } from "@/lib/metric-window-overlap";
import type { UpsertCounts, SyncRowSink } from "@/lib/integrations/sync-log";

export interface MetricSamplePushResult extends UpsertCounts {
  /**
   * The number the ingest turns into its Review line: day buckets still reading high
   * after this push finished — stored rows the plan left standing, the excess the push
   * carries against itself, and the planned deletes pass B's concurrency guard refused.
   *
   * Summed HERE the same way `ingestHealthConnectPayload` sums it, so a spec driving this
   * helper cannot pass while the real ingest reports something else.
   */
  overlapsLeft: number;
}

/** Plan, upsert, delete — one push, in the ingest's order. */
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
  const plan = planMetricSampleSupersede(profileId, rows, source, { pushedAt });
  // (2) Pass C first, then pass B — the order the last chunk's transaction runs them in.
  const counts = upsertMetricSamples(profileId, rows, source, sink, {
    pushedAt,
  });
  const superseded = applyMetricSampleSupersede(profileId, plan.victims);
  counts.superseded += superseded;
  return {
    ...counts,
    // (3) From what happened, guard-declined victims included.
    overlapsLeft:
      plan.leftStanding.length +
      plan.inPushDoubleCounts +
      (plan.victims.length - superseded),
  };
}
