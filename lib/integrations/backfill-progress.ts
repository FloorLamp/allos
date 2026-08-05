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

export function formatBackfillTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
