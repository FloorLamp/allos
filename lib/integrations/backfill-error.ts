// What a FAILED backfill job may persist in `integration_backfill_jobs.error` (#2820).
//
// The runner's catch-all used to write the raw caught `err.message` into that column,
// two lines after handing the SAME error to `log.error` — which redacts it
// (lib/error-log-format.ts) before it reaches the admin-only error log. But the column
// is not an operator surface: IntegrationBackfillProgress renders it straight onto the
// owning profile's page. So the LESS careful of the two copies was the one a browser
// saw.
//
// A third-party client's `Error.message` routinely carries the failing request URL or a
// slice of the response body, and those carry `access_token=…` / `Bearer …` values, so
// the raw string is a secrets surface. Redaction happens HERE, at the WRITE, not at the
// render: the column is read by the progress card, by anyone holding the SQLite file,
// and by whatever reads it next, and only the write is a single chokepoint.
//
// The sibling paths that fill this column are unaffected on purpose — the
// `result.remaining > 0` sentence and a runner's own `{ error }` string are hand-built
// house copy, not a raw error surface. Only the catch-all needed this.
//
// PURE (no db, no fs) so it sits in the unit tier beside the directory's other
// pure/impure splits (raw-log-format.ts vs raw-log.ts, sync-log.ts vs connections.ts).

import { capDetail, redactSecrets } from "@/lib/error-log-format";

// The stored error is one line on a progress card, not a stack dump, so it is bounded
// well below error-log's 4000-char detail cap: a runaway upstream message must not turn
// the card into a wall of text.
export const MAX_BACKFILL_ERROR_CHARS = 300;

// The redacted, bounded form of a caught backfill error — what may be persisted.
//
// Returns NULL rather than an empty or whitespace-only string when the error says
// nothing (an `Error("")`, a thrown `undefined`, a message that redacts away): the
// column is nullable and the card already renders its own sentence for a `failed` job
// with no error text, so a blank red line never reaches the page and the house copy
// stays spelled in exactly one place.
export function backfillErrorMessage(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = capDetail(
    redactSecrets(raw).trim(),
    MAX_BACKFILL_ERROR_CHARS
  );
  return redacted === "" ? null : redacted;
}
