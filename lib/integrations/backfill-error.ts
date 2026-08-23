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

import { capDetail } from "@/lib/error-log-format";
import { userErrorCopy } from "@/lib/user-error-copy";

// The stored error is one line on a progress card, not a stack dump, so it is bounded
// well below error-log's 4000-char detail cap: a runaway upstream message must not turn
// the card into a wall of text.
export const MAX_BACKFILL_ERROR_CHARS = 300;

// #3198 CHANGED WHAT THIS RETURNS. It used to hand back the raw redacted
// `err.message`, and the card rendered it — which is how
// `UNIQUE constraint failed: activity_segment_efforts.profile_id, …source,
// …external_id` came to sit on the owner's settings page for a week. Redaction
// answered the SECRETS question (#2820) and was never going to answer the
// comprehensibility one: this column is read by a person tracking their health, and
// SQLite vocabulary is not something they can do anything with.
//
// So the classifier decides the sentence and the raw cause goes to `log.error`,
// which the runner already calls two lines above the write that uses this. The cap
// stays: house copy is short, but the authored family passes a thrower's own
// sentence through and that has no length rule of its own.
//
// It no longer returns null. It used to, because a redacted-away message left an
// empty string and a blank red line on the card; the classifier always produces a
// sentence, so that branch became unreachable and saying so is better than keeping
// dead code around. The column stays nullable — a job that did not fail through the
// catch-all still has no error text, and the card keeps its own fallback for it.
export function backfillErrorMessage(err: unknown): string {
  return capDetail(
    userErrorCopy(err, { doing: "finish this backfill" }).trim(),
    MAX_BACKFILL_ERROR_CHARS
  );
}
