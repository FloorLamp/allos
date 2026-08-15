// Integration ids use the same source vocabulary in TypeScript and SQLite.
import { db } from "@/lib/db";
import type { IntegrationId } from "@/lib/types";

export type IntegrationBackfillStatus =
  "queued" | "running" | "paused" | "completed" | "failed";

export interface IntegrationBackfillJob {
  id: number;
  profile_id: number;
  source_id: IntegrationId;
  kind: string;
  label: string;
  item_noun: string;
  status: IntegrationBackfillStatus;
  total_items: number;
  completed_items: number;
  failed_items: number;
  request_count: number;
  active_seconds: number;
  started_at: string | null;
  retry_after_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function getIntegrationBackfillJobs(
  profileId: number,
  sourceId?: string
): IntegrationBackfillJob[] {
  if (sourceId) {
    return db
      .prepare(
        `SELECT * FROM integration_backfill_jobs
          WHERE profile_id = ? AND source_id = ? ORDER BY updated_at DESC, id DESC`
      )
      .all(profileId, sourceId) as IntegrationBackfillJob[];
  }
  return db
    .prepare(
      `SELECT * FROM integration_backfill_jobs
        WHERE profile_id = ? ORDER BY updated_at DESC, id DESC`
    )
    .all(profileId) as IntegrationBackfillJob[];
}

export function getIntegrationBackfillJob(
  profileId: number,
  sourceId: string,
  kind: string
): IntegrationBackfillJob | null {
  return (
    (db
      .prepare(
        `SELECT * FROM integration_backfill_jobs
          WHERE profile_id = ? AND source_id = ? AND kind = ?`
      )
      .get(profileId, sourceId, kind) as IntegrationBackfillJob | undefined) ??
    null
  );
}
