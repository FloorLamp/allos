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
// directly — so a spec cannot drift from the ingest by re-deriving the order itself.
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
import type { UpsertCounts, SyncRowSink } from "@/lib/integrations/sync-log";

export interface MetricSamplePushResult extends UpsertCounts {
  /**
   * Distinct stored day buckets the plan left standing — the number the ingest turns
   * into its Review line. It comes off the PLAN, which knows it before the first write,
   * so it travels beside the counts instead of through a side channel keyed on them.
   */
  overlapsLeft: number;
}

/** Plan, delete, upsert — one push, in the ingest's order. */
export function pushMetricSamples(
  profileId: number,
  rows: NormMetricSample[],
  source: string,
  sink?: SyncRowSink,
  options: { pushedAt?: string | null } = {}
): MetricSamplePushResult {
  const plan = planMetricSampleSupersede(profileId, rows, source, options);
  const removed = applyMetricSampleSupersede(profileId, plan.victims);
  const counts = upsertMetricSamples(profileId, rows, source, sink, options);
  counts.superseded += removed;
  return { ...counts, overlapsLeft: plan.leftStanding.length };
}
