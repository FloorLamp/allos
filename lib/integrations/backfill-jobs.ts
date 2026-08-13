// THE #2487 BOUNDARY for this module: TypeScript names an integration source
// `sourceId`, and the persisted column is still named `provider` — the column rename
// is deferred to its own forward migration (see docs/internals/integrations-sync.md).
// Reads alias `provider AS source_id`; writes bind the TS value into the old column.
import { db, writeTx } from "@/lib/db";
import { toUtcInstant, utcInstant } from "@/lib/date";
import { createLogger } from "@/lib/log";
import type { IntegrationId } from "@/lib/types";
import { getIntegration } from "./registry";
import { getIntegrationBackfillRunner } from "./backfill-runners";
import {
  getIntegrationBackfillJob,
  type IntegrationBackfillJob,
  type IntegrationBackfillStatus,
} from "./backfill-state";
export {
  getIntegrationBackfillJob,
  getIntegrationBackfillJobs,
} from "./backfill-state";
export type { IntegrationBackfillJob } from "./backfill-state";

const log = createLogger("integration-backfill");
const FALLBACK_RETRY_MS = 15 * 60 * 1000;

export interface QueueIntegrationBackfillResult {
  job: IntegrationBackfillJob;
  shouldRun: boolean;
}

export function queueIntegrationBackfill(
  profileId: number,
  sourceId: IntegrationId,
  kind: string
): QueueIntegrationBackfillResult | { error: string } {
  const definition = getIntegration(sourceId)?.backfills?.find(
    (backfill) => backfill.id === kind
  );
  const runner = getIntegrationBackfillRunner(sourceId, kind);
  if (!definition || !runner) return { error: "Backfill is not available." };

  return writeTx(() => {
    const existing = getIntegrationBackfillJob(profileId, sourceId, kind);
    if (existing?.status === "running" || existing?.status === "queued") {
      return { job: existing, shouldRun: false };
    }
    const missing = runner.count(profileId);
    // A RE-QUEUE RESUMES, it does not restart (#2195). `paused` and `failed` are both
    // "this job stopped part-way and its imported rows are still on disk" — the only
    // difference is whether the source asked us to wait. Treating `failed` as a fresh
    // start threw away `completed_items`, `request_count` and `active_seconds` from
    // work that had genuinely happened, so a manual retry after a mid-run network
    // error showed "0 of 40" for a job that was 60 rides in, and the ETA restarted
    // with no observed throughput to divide by.
    //
    // `completed` is deliberately NOT resumable: nothing stopped part-way, so a new
    // queue over a changed candidate set is a new batch and starts at 0 of N.
    //
    // The arithmetic below is what keeps the resumed figures honest — `total` is
    // re-derived as `completed + missing` (floored at the prior total, so a shrinking
    // candidate set cannot make the bar go backwards) and `completed` is re-derived
    // from it, so neither is carried forward unchecked from a run whose candidate set
    // has since moved.
    //
    // #2385 — WORKING: a re-queue after a failed run reads "60 of 100", and the ETA
    //   keeps the throughput the first run measured. WRONG: `completed_items` exceeds
    //   `total_items`, a percentage moves backwards, or a job never returns to 0-of-N
    //   after new rides arrive. DECEPTIVE SUCCESS: "progress bars stopped resetting" —
    //   a bar that never resets is also what a resume branch taken too eagerly
    //   produces, showing healthy progress against a total that no longer describes
    //   the work; the figure to read is `total_items` still tracking
    //   `completed_items + missing`, not the absence of resets.
    const resume =
      existing?.status === "paused" || existing?.status === "failed";
    const total = resume
      ? Math.max(existing.completed_items + missing, existing.total_items)
      : missing;
    const completed = resume ? Math.max(total - missing, 0) : 0;
    const status: IntegrationBackfillStatus =
      missing === 0 ? "completed" : "queued";
    const now = utcInstant();
    db.prepare(
      `INSERT INTO integration_backfill_jobs
         (profile_id, provider, kind, label, item_noun, status, total_items,
          completed_items, failed_items, request_count, active_seconds,
          started_at, retry_after_at, finished_at, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, NULL, ?, ?)
       ON CONFLICT(profile_id, provider, kind) DO UPDATE SET
         label = excluded.label, item_noun = excluded.item_noun,
         status = excluded.status, total_items = excluded.total_items,
         completed_items = excluded.completed_items, failed_items = 0,
         request_count = excluded.request_count,
         active_seconds = excluded.active_seconds,
         started_at = excluded.started_at, retry_after_at = NULL,
         finished_at = excluded.finished_at, error = NULL,
         updated_at = excluded.updated_at`
    ).run(
      profileId,
      sourceId,
      kind,
      definition.label,
      definition.itemNoun,
      status,
      total,
      completed,
      resume ? (existing?.request_count ?? 0) : 0,
      resume ? (existing?.active_seconds ?? 0) : 0,
      resume ? (existing?.started_at ?? now) : now,
      status === "completed" ? now : null,
      existing?.created_at ?? now,
      now
    );
    return {
      job: getIntegrationBackfillJob(profileId, sourceId, kind)!,
      shouldRun: status === "queued",
    };
  });
}

export async function runIntegrationBackfillJob(
  profileId: number,
  sourceId: string,
  kind: string
): Promise<IntegrationBackfillJob | null> {
  const runner = getIntegrationBackfillRunner(sourceId, kind);
  if (!runner) return null;
  const claimed = writeTx(() =>
    db
      .prepare(
        `UPDATE integration_backfill_jobs
            SET status = 'running', retry_after_at = NULL, error = NULL,
                updated_at = ?
          WHERE profile_id = ? AND provider = ? AND kind = ?
            AND status IN ('queued','paused')`
      )
      .run(utcInstant(), profileId, sourceId, kind)
  );
  if (claimed.changes !== 1) {
    return getIntegrationBackfillJob(profileId, sourceId, kind);
  }
  const initial = getIntegrationBackfillJob(profileId, sourceId, kind)!;
  const batchStarted = Date.now();
  const baseSeconds = initial.active_seconds;
  const baseRequests = initial.request_count;

  try {
    const result = await runner.run(profileId, (progress) => {
      const activeSeconds =
        baseSeconds + Math.max((Date.now() - batchStarted) / 1000, 0.001);
      const completed = Math.max(
        initial.total_items - progress.remaining,
        initial.completed_items
      );
      writeTx(() =>
        db
          .prepare(
            `UPDATE integration_backfill_jobs
                SET completed_items = ?, failed_items = ?, request_count = ?,
                    active_seconds = ?, updated_at = ?
              WHERE profile_id = ? AND provider = ? AND kind = ? AND status = 'running'`
          )
          .run(
            completed,
            // ONE stored column for two runner counts, on purpose (#2196). The job's
            // own status already separates them: a retryable failure keeps
            // `remaining > 0`, which ends the job `failed`, so a job that reaches
            // `completed` with `failed_items > 0` can only be carrying unavailable
            // ones. The progress surface derives the wording from that pair rather
            // than from a second column (backfillFailureLabel).
            progress.failed + progress.unavailable,
            baseRequests + progress.requests,
            activeSeconds,
            utcInstant(),
            profileId,
            sourceId,
            kind
          )
      );
    });
    if ("error" in result) {
      const now = utcInstant();
      writeTx(() =>
        db
          .prepare(
            `UPDATE integration_backfill_jobs
                SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
              WHERE profile_id = ? AND provider = ? AND kind = ? AND status = 'running'`
          )
          .run(result.error, now, now, profileId, sourceId, kind)
      );
    } else {
      const now = new Date();
      const completed = Math.max(initial.total_items - result.remaining, 0);
      // `remaining` is "still worth asking about", not "still missing" (#2196): a
      // runner subtracts the candidates the source gave a final answer for. Without
      // that, one permanently-unfetchable row held the whole job in `failed` forever
      // while the bar said "retrying" about work that could never succeed.
      const done = result.remaining === 0;
      const paused = !done && result.paused;
      const status: IntegrationBackfillStatus = done
        ? "completed"
        : paused
          ? "paused"
          : "failed";
      const retryAfter = paused
        ? (toUtcInstant(result.retryAfterAt) ??
          utcInstant(new Date(now.getTime() + FALLBACK_RETRY_MS)))
        : null;
      const notCompleted = result.failed + result.unavailable;
      const failedCount = Math.max(notCompleted, result.remaining);
      const error =
        status === "failed"
          ? `${failedCount} ${initial.item_noun}${failedCount === 1 ? "" : "s"} could not be completed. Retry the backfill.`
          : null;
      writeTx(() =>
        db
          .prepare(
            `UPDATE integration_backfill_jobs
                SET status = ?, completed_items = ?, failed_items = ?,
                    request_count = ?, active_seconds = ?, retry_after_at = ?,
                    finished_at = ?, error = ?, updated_at = ?
              WHERE profile_id = ? AND provider = ? AND kind = ? AND status = 'running'`
          )
          .run(
            status,
            completed,
            notCompleted,
            baseRequests + result.requests,
            baseSeconds + Math.max((Date.now() - batchStarted) / 1000, 0.001),
            retryAfter,
            status === "paused" ? null : utcInstant(now),
            error,
            utcInstant(now),
            profileId,
            sourceId,
            kind
          )
      );
    }
  } catch (err) {
    log.error("integration backfill runner failed", {
      profileId,
      sourceId,
      kind,
      err: String(err),
    });
    const now = utcInstant();
    writeTx(() =>
      db
        .prepare(
          `UPDATE integration_backfill_jobs
              SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
            WHERE profile_id = ? AND provider = ? AND kind = ? AND status = 'running'`
        )
        .run(
          err instanceof Error ? err.message : String(err),
          now,
          now,
          profileId,
          sourceId,
          kind
        )
    );
  }
  return getIntegrationBackfillJob(profileId, sourceId, kind);
}

export async function resumeDueIntegrationBackfills(
  profileId: number,
  at: Date = new Date()
): Promise<void> {
  const due = db
    .prepare(
      `SELECT provider AS source_id, kind FROM integration_backfill_jobs
        WHERE profile_id = ?
          AND (status = 'queued' OR (
            status = 'paused' AND retry_after_at IS NOT NULL AND retry_after_at <= ?
          ))
        ORDER BY updated_at`
    )
    .all(profileId, utcInstant(at)) as { source_id: string; kind: string }[];
  for (const job of due) {
    await runIntegrationBackfillJob(profileId, job.source_id, job.kind);
  }
}
