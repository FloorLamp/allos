// Stuck-extraction lease reaper (issue #135, item 4). Background AI extraction
// flips a `medical_documents` row to `extraction_status = 'processing'` and runs
// fire-and-forget in-process. A crash is handled at boot (bootTasks resets any row
// left mid-flight), but a process that STAYS UP with a hung extraction — a
// never-resolving API call, a wedged import — leaves the row spinning on
// 'processing' forever, with no lease or timeout.
//
// This closes that gap: migration 004 stamps `processing_started_at` whenever a row
// enters 'processing', and the hourly tick calls reapStuckExtractions() to mark
// 'failed' any row whose lease has run past the timeout. The user then sees a clear
// error and can reprocess, instead of an eternal spinner.
//
// GLOBAL maintenance by design: like the boot reset (boot-tasks.ts) and the
// undo-delete sweep, it runs once per hourly tick across every profile and only
// touches rows a hung extraction left mid-flight (keyed by the lease timestamp), so
// it is intentionally profile-agnostic. It never reads or writes a profile's actual
// records — only the transient extraction_status of a wedged document row.

import { db } from "./db";

// How long a document may sit in 'processing' before the reaper considers its
// extraction wedged. Extractions normally settle in seconds to a couple of minutes;
// 30m is comfortably past the slowest legitimate run (a large multi-page PDF) while
// still freeing a truly-hung row within the hour. Overridable per deploy via env.
export const DEFAULT_EXTRACTION_LEASE_MINUTES = 30;

function leaseMinutes(): number {
  const raw = process.env.EXTRACTION_LEASE_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EXTRACTION_LEASE_MINUTES;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_EXTRACTION_LEASE_MINUTES;
}

const STUCK_EXTRACTION_MESSAGE =
  "Extraction timed out (no result within the lease window). Reprocess to retry.";

// Mark 'failed' every document stuck in 'processing' longer than `minutes`. Returns
// how many rows were reaped (for the tick log). A row with a NULL
// `processing_started_at` is skipped — either it isn't actually processing, or it
// is a pre-migration 'processing' row the boot reset already owns. Best-effort: the
// caller runs this inside a try/catch so a reap failure never affects the
// notification flow. See the module header for the global-scope justification (also
// recorded in the profile-scoping allowlist).
export function reapStuckExtractions(minutes: number = leaseMinutes()): number {
  const mins =
    Number.isInteger(minutes) && minutes >= 1
      ? minutes
      : DEFAULT_EXTRACTION_LEASE_MINUTES;
  const info = db
    .prepare(
      `UPDATE medical_documents
          SET extraction_status = 'failed',
              extraction_error = ?
        WHERE extraction_status = 'processing'
          AND processing_started_at IS NOT NULL
          AND processing_started_at < datetime('now', ?)`
    )
    .run(STUCK_EXTRACTION_MESSAGE, `-${mins} minutes`);
  return info.changes;
}
