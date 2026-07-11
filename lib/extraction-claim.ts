import { db } from "./db";

// Atomic claim for a medical_documents row about to run extraction (issue #324).
//
// Background extraction flips a row to extraction_status = 'processing' and runs
// fire-and-forget. TWO paths start an extraction on an EXISTING row: the reprocess
// action (beginReprocess) and a duplicate upload whose stored row is 'failed'
// (uploadMedicalDocument re-extracts it instead of storing a second copy). Both must
// claim the row atomically — an app-level `status === 'failed'` read is NOT atomic
// with the flip, so two concurrent callers (double-click, two tabs) could both see
// 'failed', both flip, and both dispatch: allowExtractionDispatch charges the daily
// AI quota TWICE and two runExtraction calls race on one docId (one's work is
// discarded). The `AND extraction_status != 'processing'` predicate makes the flip
// itself the claim — exactly one UPDATE mutates a row; the loser gets changes === 0.
//
// Returns true iff THIS call won the claim (the caller may now dispatch); false
// means the row was already in flight (the caller must NOT dispatch). Sharing this
// one statement keeps the two call sites from drifting apart — the bug in #324 was
// precisely that the duplicate-upload path had NO claim while reprocess did.
export function claimDocumentForExtraction(
  profileId: number,
  docId: number
): boolean {
  const claimed = db
    .prepare(
      "UPDATE medical_documents SET extraction_status = 'processing', extraction_error = NULL, processing_started_at = datetime('now') WHERE id = ? AND profile_id = ? AND extraction_status != 'processing'"
    )
    .run(docId, profileId);
  return claimed.changes === 1;
}
