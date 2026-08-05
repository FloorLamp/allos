import type { IntegrationId } from "@/lib/types";
import {
  countMissingStravaRideDetails,
  runStravaDetailsBackfill,
  type StravaBackfillProgress,
  type StravaBackfillResult,
} from "./strava-sync";
import { getIntegration } from "./registry";

export interface IntegrationBackfillProgress {
  remaining: number;
  failed: number;
  requests: number;
}

export interface IntegrationBackfillBatchResult extends IntegrationBackfillProgress {
  completed: number;
  paused: boolean;
  retryAfterAt: string | null;
}

export interface IntegrationBackfillRunner {
  provider: IntegrationId;
  kind: string;
  count(profileId: number): number;
  run(
    profileId: number,
    onProgress: (progress: IntegrationBackfillProgress) => void
  ): Promise<IntegrationBackfillBatchResult | { error: string }>;
}

const RUNNERS: IntegrationBackfillRunner[] = [
  {
    provider: "strava",
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
        requests: typed.requests,
        paused: typed.paused,
        retryAfterAt: typed.retryAfterAt,
      };
    },
  },
];

for (const runner of RUNNERS) {
  const declared = getIntegration(runner.provider)?.backfills?.some(
    (backfill) => backfill.id === runner.kind
  );
  if (!declared) {
    throw new Error(
      `Backfill runner ${runner.provider}/${runner.kind} is not declared in the integration registry`
    );
  }
}

export function getIntegrationBackfillRunner(
  provider: string,
  kind: string
): IntegrationBackfillRunner | null {
  return (
    RUNNERS.find(
      (runner) => runner.provider === provider && runner.kind === kind
    ) ?? null
  );
}
