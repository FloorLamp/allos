"use client";

import { useCallback, useEffect, useState } from "react";
import type { IntegrationBackfillJob } from "@/lib/integrations/backfill-state";
import {
  formatBackfillTime,
  integrationBackfillView,
} from "@/lib/integrations/backfill-progress";

export const INTEGRATION_BACKFILL_STARTED_EVENT =
  "allos:integration-backfill-started";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default function IntegrationBackfillProgress({
  provider,
  initialJobs,
  watch = false,
}: {
  provider: string;
  initialJobs: IntegrationBackfillJob[];
  watch?: boolean;
}) {
  const [jobs, setJobs] = useState(initialJobs);

  const poll = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/jobs/integration-backfills?provider=${encodeURIComponent(provider)}`,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const body = (await response.json()) as {
        ok?: boolean;
        jobs?: IntegrationBackfillJob[];
      };
      if (body.ok && Array.isArray(body.jobs)) setJobs(body.jobs);
    } catch {
      // A progress read is observational; keep the last durable snapshot offline.
    }
  }, [provider]);

  const running = jobs.some((job) =>
    ["queued", "running"].includes(job.status)
  );
  const active = running || jobs.some((job) => job.status === "paused");

  useEffect(() => {
    const onStarted = () => void poll();
    window.addEventListener(INTEGRATION_BACKFILL_STARTED_EVENT, onStarted);
    if (!watch && !active) {
      return () =>
        window.removeEventListener(
          INTEGRATION_BACKFILL_STARTED_EVENT,
          onStarted
        );
    }
    const timer = window.setInterval(poll, running ? 2_000 : 6_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(INTEGRATION_BACKFILL_STARTED_EVENT, onStarted);
    };
  }, [active, poll, running, watch]);

  if (jobs.length === 0) return null;

  return (
    <div
      className="mt-3 space-y-3"
      data-testid={`backfill-progress-${provider}`}
    >
      {jobs.map((job) => {
        const view = integrationBackfillView(job);
        const status =
          job.status === "running"
            ? "Running"
            : job.status === "queued"
              ? "Starting"
              : job.status === "paused"
                ? "Waiting for quota"
                : job.status === "completed"
                  ? "Complete"
                  : "Failed";
        const eta =
          view.etaSeconds == null
            ? "ETA available after the first completed item"
            : `ETA ${formatBackfillTime(view.etaSeconds)}`;
        return (
          <div
            key={`${job.provider}:${job.kind}`}
            className="rounded-lg border border-black/5 bg-slate-50/70 p-3 dark:border-white/5 dark:bg-white/3"
            data-testid={`backfill-job-${job.kind}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                {job.label}
              </p>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {status}
              </span>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-ink-700"
              role="progressbar"
              aria-label={job.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={view.percent}
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] motion-reduce:transition-none"
                style={{ width: `${view.percent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
              {plural(job.completed_items, job.item_noun)} of {job.total_items}{" "}
              · {view.percent}%
              {job.failed_items > 0 ? ` · ${job.failed_items} retrying` : ""}
            </p>
            {job.status === "paused" && view.resumesInSeconds != null ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Next retry in {formatBackfillTime(view.resumesInSeconds)} ·{" "}
                {eta}
              </p>
            ) : job.status === "running" || job.status === "queued" ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {eta}
              </p>
            ) : job.status === "failed" ? (
              <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">
                {job.error ?? "Backfill stopped. Try again."}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
