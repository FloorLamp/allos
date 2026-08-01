// The PURE per-file OUTCOME decision behind POST /api/documents (issue #1735): what word
// describes what happened to each uploaded file. No DB, no fs, no request — so the route
// stays a thin shell over one decision.
//
// (Destination parsing moved to lib/acquirer-identity.ts when #1739 added the identity
// form: "which profile does this request target" became a single exactly-one-of decision
// across both the `profile` and `(portal, patient)` shapes, and splitting it across two
// modules would have meant two parsers for one question.)
//
// The translation from the row `ingestMedicalUpload` landed on into the word an API
// caller gets back.
//
// WHY THIS EXISTS. The ingest engine lands a `medical_documents` row on EVERY path — a
// stored 'processing' document, the pre-existing row a duplicate deduped onto, or a
// 'failed'/'skipped' marker carrying the reason — and returns its id. That is what makes
// per-file truth free for a JSON API: the endpoint never has to guess, and never has to
// answer a blanket success for a batch where one file was rejected (the typed-outcome
// invariant). But the engine's own vocabulary is the extraction lifecycle
// ('processing' / 'done' / 'failed' / 'skipped'), which is NOT the same question as
// "did my upload land". This module is the one place that maps between them.
//
// Pure (no DB, no fs), so the mapping is unit-testable and so the route stays a thin
// shell over one decision.

// What happened to one uploaded file, from the caller's point of view.
//
//   stored    — the file is in the record and extraction is underway. This is success.
//   duplicate — the instance already had these exact bytes for this profile; nothing
//               new was stored. Not an error: re-running an upload is meant to be safe,
//               and dedup is per profile by design.
//   failed    — the engine refused the file (too large, unsupported type, contents that
//               contradict the declared type, or it could not be written to disk). The
//               reason line comes back with it.
//   blocked   — a person DELETED these exact bytes in allos, and the content-hash
//               tombstone (#1777) refuses the re-offer. Emphatically not a failure and
//               never worth retrying: the client's job is to stop offering it, which is
//               what #1776's inventory `deleted` list lets it do without ever sending
//               the body. A person can reverse it from Data → Review.
export type UploadOutcome = "stored" | "duplicate" | "failed" | "blocked";

// The reason line a `blocked` outcome carries. Owned here rather than typed at the route
// so the endpoint, the contract doc, and the tests quote ONE sentence — and so it names
// the surface that reverses it, because a client author reading only this line has to
// know the deletion was deliberate and where its user can undo it.
export const BLOCKED_REASON =
  "deleted in allos; a user can allow re-acquisition from Data → Review";

export interface LandedDocumentRow {
  // The id ingestMedicalUpload returned.
  docId: number;
  // The highest medical_documents id that existed immediately BEFORE this one file was
  // ingested. See the reprocess note below.
  maxIdBefore: number;
  // medical_documents.extraction_status on the landed row.
  status: string;
  // medical_documents.stored_path — empty/NULL means no file was written for this row.
  storedPath: string | null;
  // medical_documents.extraction_error — the engine's own reason line, when it has one.
  error: string | null;
}

export interface ClassifiedUpload {
  outcome: UploadOutcome;
  // The engine's reason, verbatim, for the outcomes that carry one. Never invented
  // here: if the engine did not write a reason, the caller gets null rather than a
  // sentence this module made up.
  reason: string | null;
}

export function classifyUploadOutcome(
  row: LandedDocumentRow
): ClassifiedUpload {
  // The engine has one path that returns a PRE-EXISTING row rather than a new one:
  // identical bytes whose original document had failed extraction and still has its
  // file, which it reprocesses in place instead of storing a second copy. Nothing on
  // that row distinguishes it from a fresh upload — it is 'processing' with a real
  // stored_path — so the id is the only signal, and it is a reliable one because
  // `api_tokens`-era medical_documents ids are monotonic within a request. The honest
  // word for "your bytes were already here and no new document was created" is
  // duplicate.
  if (row.docId <= row.maxIdBefore) {
    return { outcome: "duplicate", reason: row.error };
  }

  // A row with NO file on disk is a marker, not a document: the engine writes one when
  // it refuses ('failed') or when it deduped onto an existing document ('skipped').
  // Both carry their reason in extraction_error. Everything else — including a
  // 'skipped' row that DOES have a file (the AI queue shed its extraction) — is a
  // stored document whose extraction outcome is a Review concern, not an upload one.
  const hasFile = !!row.storedPath;
  if (!hasFile && row.status === "skipped") {
    return { outcome: "duplicate", reason: row.error };
  }
  if (!hasFile && row.status === "failed") {
    return { outcome: "failed", reason: row.error };
  }
  return { outcome: "stored", reason: null };
}

// Whether a set of outcomes should be reported as a failure by a caller that has to
// choose ONE answer for a whole batch — the CLI's exit code, and nothing else. A
// duplicate is deliberately NOT a failure: re-running an upload is a supported,
// idempotent thing to do, and making it exit non-zero would break every cron that
// re-scans the same folder.
export function anyUploadFailed(outcomes: readonly UploadOutcome[]): boolean {
  return outcomes.includes("failed");
}
