export interface BackfillProgressInput {
  status: "queued" | "running" | "paused" | "completed" | "failed";
  total_items: number;
  completed_items: number;
  active_seconds: number;
  retry_after_at: string | null;
}

export interface BackfillProgressView {
  percent: number;
  remaining: number;
  etaSeconds: number | null;
  resumesInSeconds: number | null;
}

export function integrationBackfillView(
  job: BackfillProgressInput,
  at: Date = new Date()
): BackfillProgressView {
  const remaining = Math.max(job.total_items - job.completed_items, 0);
  const percent =
    job.total_items === 0
      ? job.status === "completed"
        ? 100
        : 0
      : Math.min(
          100,
          Math.round((job.completed_items / job.total_items) * 100)
        );
  const workSeconds =
    job.completed_items > 0
      ? Math.ceil((job.active_seconds / job.completed_items) * remaining)
      : null;
  const resumesInSeconds =
    job.status === "paused" && job.retry_after_at
      ? Math.max(
          0,
          Math.ceil((Date.parse(job.retry_after_at) - at.getTime()) / 1000)
        )
      : null;
  return {
    percent,
    remaining,
    etaSeconds:
      workSeconds == null
        ? null
        : workSeconds + (resumesInSeconds == null ? 0 : resumesInSeconds),
    resumesInSeconds,
  };
}

// What the progress line calls a job's not-completed items (#2196).
//
// `failed_items` holds retryable failures AND items the source gave a final answer
// for, because the JOB STATUS already separates them and a second column would be a
// second place for the two to disagree: a retryable failure keeps `remaining > 0`,
// which ends the run `failed`, so a `completed` job's leftovers can only be the
// permanent kind. Saying "retrying" about those was the visible half of the bug —
// it promised a success that was never coming.
export function backfillFailureLabel(
  status: BackfillProgressInput["status"],
  failedItems: number
): string | null {
  if (failedItems <= 0) return null;
  // A queued/running/paused job may hold a mix; "retrying" is the honest word there,
  // because the run those items belong to has not reached its verdict yet.
  return `${failedItems} ${status === "completed" ? "unavailable" : "retrying"}`;
}

export function formatBackfillTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
