import type { IntegrationId } from "@/lib/types";
import {
  countMissingStravaRideDetails,
  runStravaDetailsBackfill,
  type StravaBackfillProgress,
  type StravaBackfillResult,
} from "./strava-sync";
import { getIntegration } from "./registry";

export interface IntegrationBackfillProgress {
  // Candidates still worth asking the source about. A runner that can reach a FINAL
  // answer for an item excludes it here even when its own missing-row query still
  // matches the row, which is what lets a job finish (#2196).
  remaining: number;
  // Items this run could not complete but a retry might.
  failed: number;
  // Items the source gave a final answer for: refused, gone, or answered with no
  // payload. Never folded into `failed` on the way up — a retry cannot move them, so
  // the two must stay separable for the job to decide `completed` vs `failed`.
  unavailable: number;
  requests: number;
}

export interface IntegrationBackfillBatchResult extends IntegrationBackfillProgress {
  completed: number;
  paused: boolean;
  retryAfterAt: string | null;
}

export interface IntegrationBackfillRunner {
  sourceId: IntegrationId;
  kind: string;
  count(profileId: number): number;
  run(
    profileId: number,
    onProgress: (progress: IntegrationBackfillProgress) => void
  ): Promise<IntegrationBackfillBatchResult | { error: string }>;
}

const RUNNERS: IntegrationBackfillRunner[] = [
  {
    sourceId: "strava",
    kind: "ride-details",
    count: countMissingStravaRideDetails,
    async run(profileId, onProgress) {
      const result = await runStravaDetailsBackfill(
        profileId,
        (progress: StravaBackfillProgress) => onProgress(progress)
      );
      if ("error" in result) return result;
      const typed: StravaBackfillResult = result;
      return {
        completed: typed.backfilled,
        remaining: typed.remaining,
        failed: typed.failed,
        unavailable: typed.unavailable,
        requests: typed.requests,
        paused: typed.paused,
        retryAfterAt: typed.retryAfterAt,
      };
    },
  },
];

for (const runner of RUNNERS) {
  const declared = getIntegration(runner.sourceId)?.backfills?.some(
    (backfill) => backfill.id === runner.kind
  );
  if (!declared) {
    throw new Error(
      `Backfill runner ${runner.sourceId}/${runner.kind} is not declared in the integration registry`
    );
  }
}

export function getIntegrationBackfillRunner(
  sourceId: string,
  kind: string
): IntegrationBackfillRunner | null {
  return (
    RUNNERS.find(
      (runner) => runner.sourceId === sourceId && runner.kind === kind
    ) ?? null
  );
}
