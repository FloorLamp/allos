// Medical document PIPELINE engine (issue #318). The business logic behind the
// document server actions (app/(app)/medical/document-actions.ts): upload
// ingest + dedup, AI/health-record extraction dispatch, the reprocess core, and
// the read-only reprocess preview/cost. Split out of the medical actions file so
// the pipeline is reachable from the DB test tier (the actions there are thin
// auth-and-revalidate wrappers over these functions). Record CRUD (addRecord/
// updateRecord/deleteRecord) stays in app/(app)/medical/actions.ts; the
// reassign/delete actions stay in document-actions.ts because they are already
// thin and auth-shaped. (The extraction-status snapshot the toaster polls is no
// longer an action at all — it is app/api/jobs/extractions, see #1878.)
//
// The import footprint (clearImportedDocumentRows / the reassign move set /
// extracted_count) is untouched here — it lives in lib/import-persist and stays
// bound by its tests; this module only relocates the engine that drives it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { revalidateRoute } from "@/lib/revalidate";
import { db, today, writeTx } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { isRealIsoDate } from "@/lib/date";
import { extractMedicalDocument, isSupportedFile } from "@/lib/medical-extract";
import type { ExtractionResult } from "@/lib/medical-extract";
import {
  resultFromExtractionInput,
  unwrapExtractionInput,
  looksLikeExtractionInput,
} from "@/lib/medical-extract";
import {
  MAX_AI_BYTES,
  MAX_HEALTH_BYTES,
  preBufferSizeCap,
} from "@/lib/upload-gate";
import { sniffUploadType } from "@/lib/file-sniff";
import { isTaskConfigured } from "@/lib/ai-resolve";
import { claimDocumentForExtraction } from "@/lib/extraction-claim";
import { withAiLogContext } from "@/lib/ai-log";
import {
  checkAndIncrementAiUsage,
  extractionDailyLimit,
  refundAiUsage,
} from "@/lib/ai-usage";
import { extractionSemaphore, QueueFullError } from "@/lib/ai-concurrency";
import {
  getCanonicalVocabulary,
  getMedicalDocument,
  getReprocessSnapshot,
  foldConsolidatedMedsIntoSnapshot,
  pruneDeferredMetricsFromSnapshot,
  previewReconcileFlags,
  cleanupOrphanBiomarkerKeyedState,
} from "@/lib/queries";
import { runRecommendation } from "@/lib/recommendation-engine";
import {
  extractionToPersistInput,
  healthRecordToPersistInput,
  type PersistInput,
} from "@/lib/import-shape";
import {
  persistDocumentImport,
  applyImportFollowups,
} from "@/lib/import-persist";
import {
  detectHealthRecord,
  persistHealthRecordDoc,
} from "@/lib/health-record-doc";
import { parseHealthRecord } from "@/lib/health-record-parse";
import {
  buildCanonicalIndex,
  snapCanonicalNameIntoBatch,
  distinguishVitaminDIsoform,
} from "@/lib/canonical-name";
import {
  snapshotFromPersistInput,
  computeImportDiff,
  type ImportDiff,
} from "@/lib/import-diff";
import {
  stashPreviewInput,
  takePreviewInput,
  evictPreviewsForDocument,
} from "@/lib/reprocess-preview-cache";
import {
  clearDocumentTombstone,
  isDocumentTombstoned,
} from "@/lib/document-tombstones";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";
export {
  findDedupTarget,
  findClinicalDuplicate,
  heldDocumentHashes,
  type DedupTarget,
  UPLOAD_DIR,
} from "@/lib/medical-pipeline/storage";
import {
  findDedupTarget,
  findClinicalDuplicate,
  insertClinicalDuplicateDoc,
  insertDuplicateDoc,
  insertFailedDoc,
  persistUploadedFile,
  type DedupTarget,
} from "@/lib/medical-pipeline/storage";
import {
  clinicalDuplicateMessage,
  clinicalKeyForInput,
} from "@/lib/clinical-content-key";
import { recordCoverageMarker } from "@/lib/document-coverage";
export { computeReprocessAllCost } from "@/lib/medical-pipeline/reprocess-cost";

const log = createLogger("medical");

// The upload size ceilings and the pre-buffer gate policy live in the pure
// lib/upload-gate module (no DB import) so they stay unit-testable and importable
// by the next.config lockstep guard. Re-exported here (issue #696) so existing
// importers of MAX_AI_BYTES / MAX_HEALTH_BYTES keep their `@/lib/medical-pipeline`
// path.
export { MAX_AI_BYTES, MAX_HEALTH_BYTES } from "@/lib/upload-gate";

// Model-supplied dates are only *asked* to be ISO — validate before storing so a
// hallucinated "Friday" or "2026-13-45" can't land in a YYYY-MM-DD column.
// isRealIsoDate checks calendar validity too, not just the shape.
const isIsoDate = isRealIsoDate;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

// Surfaced (as the document's extraction_error) when the profile's daily AI
// extraction cap is hit: the file is STORED but not sent to the model. This reuses
// the SAME 'skipped' status the no-API-key path already sets, so the documents
// list shows the existing degraded state — no new error surface, no lost file, and
// never a hard-errored request.
const AI_DAILY_LIMIT_DOC_MESSAGE =
  "Daily AI limit reached — document saved but not auto-extracted. It won't be sent to the model today; reprocess it tomorrow.";

// Gate AI extraction dispatch on the profile's daily cap (rate-limiting Fix 1).
// Returns true when extraction may run. When an API key is present this consumes
// one unit of the profile's daily extraction quota; on exhaustion it marks the
// document 'skipped' (reusing the stored-but-not-extracted signal) and returns
// false — the file is kept, extraction is skipped, never a hard error. With NO key
// it returns true WITHOUT consuming quota: the dispatch still runs and
// extractMedicalDocument records its own no-key skip, so we don't burn quota when
// AI is disabled/degraded anyway (only count when a Claude call really dispatches).
function allowExtractionDispatch(profileId: number, docId: number): boolean {
  if (!isTaskConfigured("extraction")) return true;
  const { allowed } = checkAndIncrementAiUsage(
    profileId,
    "extraction",
    extractionDailyLimit()
  );
  if (!allowed) {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(AI_DAILY_LIMIT_DOC_MESSAGE, docId, profileId);
    return false;
  }
  return true;
}

// Surfaced when the concurrency limiter's wait queue is saturated (#135 item 2):
// the file is stored but its extraction was SHED rather than parked, so it reuses
// the 'skipped' surface (kept, reprocessable) and the charged unit is refunded.
const AI_QUEUE_FULL_DOC_MESSAGE =
  "Server busy — too many documents extracting at once. Saved but not auto-extracted; reprocess it in a moment.";

// Dispatch a fire-and-forget background AI extraction: gate on the daily cap, then
// run it through the process-wide concurrency limiter (at most N at once; the rest
// queue up to the queue cap) inside the AI-log context so the acting login/profile
// tag the background call. A no-op when the cap denies (the doc is already marked
// 'skipped').
//
// Memory discipline (#135 item 2): the queued closure holds only the stored PATH,
// not the upload bytes — the file is re-read from disk once the job's slot frees, so
// a burst of large uploads parks path strings rather than 32MB buffers. If the wait
// queue is full the limiter rejects with QueueFullError; we shed the job to the
// 'skipped' surface and refund. runExtraction otherwise catches its own errors and
// finalizes the row, so the ExtractionToaster poller always sees a terminal state.
function dispatchExtraction(
  loginId: number,
  profileId: number,
  docId: number,
  storedPath: string,
  mime: string,
  filename: string
): void {
  if (!allowExtractionDispatch(profileId, docId)) return;
  // A quota unit was consumed above ONLY when an API key is configured; a no-key
  // dispatch runs but records its own skip, so it was never charged and must never
  // be refunded (that would drive the counter below its true value).
  const charged = isTaskConfigured("extraction");
  void withAiLogContext({ loginId, profileId }, () =>
    extractionSemaphore.run(async () => {
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(path.join(process.cwd(), storedPath));
      } catch (err) {
        log.error("extraction: could not read stored file", {
          docId,
          profile: profileId,
          err: err instanceof Error ? err : String(err),
        });
        db.prepare(
          "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
        ).run(`Could not read stored file: ${errMsg(err)}`, docId, profileId);
        // Charged but nothing extracted — hand the unit back (#135 item 3).
        if (charged) refundAiUsage(profileId, "extraction");
        return;
      }
      return runExtraction(
        profileId,
        docId,
        buffer,
        mime,
        filename,
        charged,
        loginId
      );
    })
  ).catch((err) => {
    // The limiter shed this dispatch (wait queue full): keep the file, mark it
    // 'skipped' so it can be reprocessed, and refund the charged unit.
    if (err instanceof QueueFullError) {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
      ).run(AI_QUEUE_FULL_DOC_MESSAGE, docId, profileId);
      if (charged) refundAiUsage(profileId, "extraction");
      return;
    }
    // Unexpected — runExtraction owns its own failures, so a rejection here means
    // something above it threw. Mark failed (don't leave the row spinning) + refund.
    log.error("extraction dispatch rejected unexpectedly", { docId, err });
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(`Extraction dispatch failed: ${errMsg(err)}`, docId, profileId);
    if (charged) refundAiUsage(profileId, "extraction");
  });
}

// A medical_documents row that can serve as a content-hash dedup target for a new
// upload (issue #612). Matches only a row that still has its stored file, OR an
// in-flight placeholder ('processing'/'pending') that a concurrent upload of the
// same bytes reserved but hasn't written to disk yet. A file-less TERMINAL marker —
// a 'skipped' duplicate row (stored_path = '') or a pre-upload 'failed' typing row —
// is EXCLUDED: it carries the hash but no servable/reprocessable file, so letting it
// match made a file permanently un-re-uploadable after the original document was
// deleted. Excluding it lets the re-upload proceed fresh AND heals a pre-existing
// stranded marker. The in-flight placeholder stays matchable so two simultaneous
// identical uploads still dedup to one document (the reserve-row race the ingest
// transaction guards). Kept as a named export so the DB tier can pin the decision.
// What one ingest did (issues #1735, #1776, #1777).
//
// This grew a shape when the ACQUIRER path stopped always landing a row. Until then
// "the id of the row this landed on" was a total answer, because every path landed
// one; two decisions broke that, and both of them are the point:
//
//   • a TOMBSTONED hash offered by an automated client is refused outright — writing a
//     marker row would be recording an event as a document;
//   • a recognized DUPLICATE offered by an automated client lands no marker either
//     (#1776's ruling), which is what restores table idempotency for a retry. The
//     human upload form keeps its 'skipped' marker: there, the row IS the feedback
//     surface, and a person who re-picks a file deserves to see why nothing happened.
//
// The sync report — not a row — is the acquirer's record of both, which is where the
// integrations accounting rule already says a run's counts belong.
export interface IngestOutcome {
  // The medical_documents row this ingest landed on. NULL only on the acquirer path,
  // and only for the two deliberate no-row refusals below.
  docId: number | null;
  // Why no row was written, when none was. NULL whenever docId is set.
  //   blocked          — the user deleted these bytes; the tombstone refused the re-offer.
  //   already-held     — this profile already has these exact bytes stored.
  //   already-imported — different bytes, same records: every clinical entry in the
  //                      offered health record is already imported from another document
  //                      of this profile (#1780). The one an acquirer hits repeatedly,
  //                      because a portal regenerates its container on every collection
  //                      and the byte hash therefore never repeats. Still no row — but a
  //                      COVERAGE MARKER is written (#1828) so the inventory can put this
  //                      hash in its `covered` list and the client stops re-offering it.
  refusal: "blocked" | "already-held" | "already-imported" | null;
  // This upload CLEARED a content-hash tombstone: the user had deleted these bytes and
  // a human has now put them back. Human paths only — an acquirer can never set it,
  // because nothing an automated client does may un-delete. Callers surface it, so a
  // restoration never happens silently (the Review list would appear to lose an entry
  // with no explanation).
  restored: boolean;
  // The bytes' identity, once known. NULL when the file was refused before hashing
  // (too large, unsupported type, contents contradicting the declared type).
  contentHash: string | null;
}

// The CLINICAL identity of an OFFERED health-record file (issue #1780), computed before
// anything is reserved or stored: parse it the way the import would and digest the
// source-minted entry ids it carries.
//
// It runs the real parse rather than a cheaper sniff because the entry ids ARE the
// answer — there is no shortcut to them — and it stops at the PersistInput, so the whole
// cost is one XML/JSON walk with no DB write. The canonical-name snap
// persistHealthRecordDoc applies is deliberately skipped: it rewrites `canonical`, never
// an `external_id`, so it cannot move the key, and running it here would mean a DB read
// on a path that is meant to be a cheap probe.
//
// A parse failure yields NULL rather than throwing. This is a DEDUP PROBE, not the
// import: a file that cannot be parsed simply has no clinical identity to compare, and it
// must still reach the storage path so the real import records the parse error on the
// row — which is where a person can see it.
function offeredClinicalKey(buffer: Buffer): string | null {
  try {
    const { parsed, source } = parseHealthRecord(buffer);
    // The label only names the document type on `meta`; the key reads external_ids only,
    // so it plays no part in the comparison.
    return clinicalKeyForInput(
      healthRecordToPersistInput(parsed, source, "Health record")
    );
  } catch {
    return null;
  }
}

// A row-landing outcome — the shape every human path returns.
function landed(
  docId: number,
  contentHash: string | null,
  restored = false
): IngestOutcome {
  return { docId, refusal: null, restored, contentHash };
}

// Ingest an uploaded medical document: validate + size-gate + content-sniff, store
// it on disk under a per-profile subdirectory, dedup on content hash, then kick off
// AI extraction (or a deterministic health-record import) in the background. Returns
// as soon as the file is saved (status 'processing'), so the document appears
// immediately; the page polls until extraction finishes and imports its results.
// The whole File is passed so the pre-buffer size gate (file.size, known from the
// multipart headers) can reject an oversized upload BEFORE reading its body.
//
// Returns the outcome of the ingest (see IngestOutcome). On every HUMAN path it
// carries the id of the medical_documents row the upload landed on — each of them
// lands one (a stored 'processing' doc, the pre-existing row a duplicate deduped
// onto, or a 'failed'/'skipped' row carrying the reason), so a caller always has a
// document to point the user at. The upload form uses only the restored flag (it
// toasts and sends the user to Review); the PWA share-target route (#1423) redirects
// to the id, which is how a shared file reaches its stored document — and, when the
// share landed on the wrong person, the detail page's "Wrong person?" reassign
// control.
export async function ingestMedicalUpload(
  loginId: number,
  profileId: number,
  file: File,
  // ACQUIRED-BY provenance (#1748). Set only by the portal-resolved upload path; every
  // human path (the form, the share sheet, a `profile=<id>` CLI push) leaves it undefined,
  // and the resulting NULL is the positive statement "a person put this here". Stamped on
  // whichever row this call lands — stored, failed, or duplicate marker — so a portal
  // upload that was rejected for its type or size still says where it came from.
  //
  // `acquirer` is the AUTOMATION flag (#1776/#1777), and it is deliberately separate from
  // the provenance id above: it selects the two behaviours that must differ for a
  // non-human caller — a tombstoned hash is REFUSED rather than un-deleted, and a
  // recognized duplicate lands NO marker row. Default false, so every human path keeps
  // its existing behaviour by construction.
  opts: { acquiredPortalId?: number | null; acquirer?: boolean } = {}
): Promise<IngestOutcome> {
  const acquiredPortalId = opts.acquiredPortalId ?? null;
  const acquirer = opts.acquirer ?? false;
  const mime = file.type || "application/octet-stream";
  // Reject an oversized upload BEFORE buffering the whole file into memory —
  // file.size is known from the multipart headers, so we needn't read a huge body
  // just to reject it. The pre-buffer ceiling defaults to the stricter 32MB AI cap
  // and only rises to the 64MB health-record cap when a CHEAP pre-buffer signal
  // (filename extension / declared MIME) suggests a genuine deterministic health
  // record — so a large non-health file is rejected here WITHOUT ever being fully
  // buffered (issue #695), instead of admitting everything to 64MB and only
  // rejecting after the whole body was read into memory. The per-path post-buffer
  // cap below re-checks the true length once the content is actually sniffed.
  const preCap = preBufferSizeCap(file.name, mime);
  if (file.size > preCap) {
    const failedId = insertFailedDoc(
      profileId,
      file.name,
      mime,
      file.size,
      `File too large (max ${Math.round(preCap / 1024 / 1024)}MB).`,
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(failedId, null);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  // A MyChart CCD/XDM or SMART Health Card is imported deterministically (no AI);
  // everything else goes to the model, so it must be an AI-supported type.
  const healthKind = detectHealthRecord(buffer);
  if (!healthKind && !isSupportedFile(file.name, mime)) {
    const failedId = insertFailedDoc(
      profileId,
      file.name,
      mime,
      file.size,
      "Unsupported file type.",
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(failedId, null);
  }
  // Enforce the per-path size cap now that the byte length AND the kind are known:
  // an AI-extracted file is bound by the Anthropic request limit (it's inlined as
  // base64), a deterministic health record is not. Also backstops the pre-buffer
  // gate against a lying/absent file.size.
  const sizeCap = healthKind ? MAX_HEALTH_BYTES : MAX_AI_BYTES;
  if (buffer.length > sizeCap) {
    const failedId = insertFailedDoc(
      profileId,
      file.name,
      mime,
      buffer.length,
      `File too large (max ${Math.round(sizeCap / 1024 / 1024)}MB).`,
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(failedId, null);
  }

  // Verify the CONTENT against its declared type/extension (issue #27). The
  // client-declared file.type is untrusted; derive a server-trusted MIME from the
  // magic bytes so the value we store (and later echo as Content-Type when serving)
  // reflects what the file actually is. A file whose bytes contradict its declared
  // type — a ".pdf" that isn't a PDF — is rejected here rather than stored under a
  // lie. Health records are exempt from rejection (detectHealthRecord/parse already
  // validated their structure); we still derive a trustworthy stored MIME for them.
  const typed = sniffUploadType({
    filename: file.name,
    declaredMime: mime,
    buffer,
    isHealthRecord: !!healthKind,
  });
  if (!typed.ok) {
    const failedId = insertFailedDoc(
      profileId,
      file.name,
      mime,
      buffer.length,
      typed.reason,
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(failedId, null);
  }
  // The byte-derived MIME is what we persist and pass onward. CSV/plain text carry
  // no reliable magic, so this falls back to a benign attachment-only type
  // (text/csv, text/plain) that is never in the serve route's INLINE_OK set.
  const storedMime = typed.mime;

  // Reject an identical file (same bytes) even if the filename differs. We hash
  // the contents and look for an existing document with the same hash. Prefer the
  // earliest one that still has its stored file (later skipped-duplicate rows
  // carry the hash but no file) — that's the original upload.
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

  // ── THE DELETION IS REMEMBERED HERE (#1777) ────────────────────────────────
  //
  // The hash is the document's identity, so this — the moment it is known and before
  // any row is reserved — is the only place the two paths can diverge on a deletion.
  //
  // AN ACQUIRER IS REFUSED. A tool that diffs against #1776's inventory and pushes the
  // difference must not be able to resurrect a document the user deleted; deletion is
  // authoritative, exactly as it is for the #507/#508 re-import tombstones. The refusal
  // returns BEFORE the reserve transaction, so a blocked offer leaves no row at all —
  // it is an event, and the sync report is its record (counted `suppressed`).
  //
  // A HUMAN WINS. A person uploading the file IS the un-delete intent, the same stance
  // the manual-edit lock takes against a sync: clear the tombstone and carry on. The
  // caller is told (`restored`) so it can say so — silently un-tombstoning would make
  // the Review blocked-list appear to lose entries for no reason.
  let restored = false;
  if (acquirer) {
    if (isDocumentTombstoned(profileId, contentHash)) {
      return {
        docId: null,
        refusal: "blocked",
        restored: false,
        contentHash,
      };
    }
  } else {
    restored = clearDocumentTombstone(profileId, contentHash);
  }
  // Do the dedup check and the placeholder-row insert atomically in one
  // transaction so two simultaneous uploads of the same bytes can't both pass the
  // check and both insert (better-sqlite3 is synchronous, so this closes the race
  // within the process). The transaction returns either the pre-existing row or
  // the id of the freshly reserved 'processing' row; file IO / extraction happen
  // afterwards, outside the transaction.
  // uploaded_at is bound from the CLOCK SEAM (sqlNow, #1534) instead of taking the
  // column's `datetime('now')` default: it is read as a calendar DAY —
  // `date(uploaded_at)` decides illness-episode membership and `substr(uploaded_at,
  // 1, 10)` is the Timeline day for a document with no clinical document_date — both
  // against `today()`-derived values. processing_started_at deliberately KEEPS SQL's
  // real clock: it is an extraction LEASE (the reaper compares it to
  // `datetime('now', '-N minutes')`), i.e. a duration, which the seam must never own.
  const insertRow = db.prepare(
    `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, content_hash, clinical_key, extraction_status, processing_started_at, uploaded_at, profile_id, acquired_portal_id)
     VALUES (?,?,?,?,?,?, 'processing', datetime('now'), ?, ?, ?)`
  );
  // ── THE RECORDS ARE RECOGNIZED HERE (#1780) ────────────────────────────────
  //
  // Computed BEFORE the reserve transaction so the parse never runs inside a write
  // transaction, and only for a deterministic health record: an AI-extracted document
  // mints no entry ids, so it has no clinical identity to compare and this stays NULL.
  //
  // It is the SECOND identity a file can be recognized by, and it sits beside the first
  // rather than replacing it. The content hash still answers "the same file, picked
  // twice"; this answers "the same records, packaged again" — the case a portal produces
  // every single collection, because it regenerates the container per request while the
  // clinical documents inside stay byte-identical.
  const clinicalKey = healthKind ? offeredClinicalKey(buffer) : null;
  const reserved = writeTx(
    ():
      | { existing: DedupTarget }
      | { clinicalHolder: DedupTarget; key: string }
      | { docId: number } => {
      const found = findDedupTarget(profileId, contentHash);
      if (found) return { existing: found };
      // Bytes are unknown; are the RECORDS? Inside the same transaction as the reserve,
      // for the same reason the hash probe is: two simultaneous collections of one visit
      // list must not both pass the check and both insert.
      if (clinicalKey) {
        const holder = findClinicalDuplicate(profileId, clinicalKey);
        if (holder) return { clinicalHolder: holder, key: clinicalKey };
      }
      const info = insertRow.run(
        file.name,
        "",
        storedMime,
        buffer.length,
        contentHash,
        // Stamped on the placeholder, not only at the 'done' finalize: a second
        // collection arriving while this one is still extracting must be recognized
        // against it, and HELD_PREDICATE already treats an in-flight row as held.
        clinicalKey,
        sqlNow(),
        profileId,
        acquiredPortalId
      );
      return { docId: Number(info.lastInsertRowid) };
    }
  );
  if ("clinicalHolder" in reserved) {
    const holder = reserved.clinicalHolder;
    // NO MARKER ROW ON THE ACQUIRER PATH, exactly as for a byte duplicate (#1776): an
    // offer of records allos already holds is an EVENT, and the sync report is its
    // record. This matters MORE here than it does for the hash: a portal's container is
    // never byte-stable, so an acquirer re-collecting daily would land a fresh marker row
    // every single day and inflate the import feed without bound.
    if (acquirer) {
      // …but the REFUSAL IS REMEMBERED (#1828). Nothing is stored, so this hash appears
      // in neither `held` nor `deleted`, and #1776's "send what is in neither list" rule
      // therefore told every acquirer to offer it again on every run, forever. The
      // marker is what lets the inventory answer a third list — evidence only: whether
      // the coverage still holds is recomputed at read, so deleting the covering document
      // silently makes this file offerable again with nothing to tell the client.
      recordCoverageMarker(profileId, contentHash, reserved.key);
      return {
        docId: null,
        refusal: "already-imported",
        restored: false,
        contentHash,
      };
    }
    // A person, though, chose this file and deserves to be told why nothing happened —
    // the row IS the feedback surface, same as the byte-duplicate marker.
    const duplicateId = insertClinicalDuplicateDoc(
      profileId,
      file.name,
      mime,
      buffer.length,
      contentHash,
      reserved.key,
      clinicalDuplicateMessage(holder.filename),
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(duplicateId, contentHash, restored);
  }
  if ("existing" in reserved) {
    const existing = reserved.existing;
    // If the original's extraction failed and its file is still on disk, the
    // useful action is to reprocess that row rather than store a second copy —
    // so kick off a fresh extraction on it (reusing the just-uploaded bytes,
    // which we know are identical) instead of creating a duplicate. Otherwise
    // (already imported, still processing, or nothing on disk) just alert.
    if (
      existing.status === "failed" &&
      existing.stored_path &&
      (healthKind || isTaskConfigured("extraction"))
    ) {
      // Claim the failed row atomically BEFORE dispatching a fresh extraction
      // (issue #324): flip to 'processing' only if it isn't already, exactly the
      // contract beginReprocess uses (same shared claim). The `existing.status ===
      // 'failed'` read above is not atomic with this write, so two concurrent
      // duplicate uploads (double-click, two tabs) could both see 'failed'; without
      // the claim both would dispatch — double-charging the daily AI quota and
      // running two extractions on one docId. The loser (claim returns false) falls
      // through to the plain duplicate alert rather than starting a second run.
      if (claimDocumentForExtraction(profileId, existing.id)) {
        if (healthKind) {
          runHealthImport(profileId, existing.id, buffer);
        } else {
          // Re-read the stored file inside the job (#135 item 2) — pass the path, not
          // the bytes. existing.stored_path is guaranteed non-null by the guard above.
          dispatchExtraction(
            loginId,
            profileId,
            existing.id,
            existing.stored_path,
            storedMime,
            existing.filename
          );
          revalidateRoute("/data");
        }
        return landed(existing.id, contentHash, restored);
      }
      // Claim lost: a concurrent upload already claimed it — fall through to the
      // duplicate alert below rather than starting a second extraction.
    }
    // NO MARKER ROW ON THE ACQUIRER PATH (#1776). An offer of bytes allos already holds
    // is an EVENT, not a document: the sync report counts it `unchanged` and that is its
    // record. Landing a 'skipped' row per attempt made an idempotent retry non-idempotent
    // in the table and visibly inflated the import feed — forcing 11 already-held
    // documents took a test instance's portal-acquired count from 11 to 22. The human
    // upload form still lands one below, because there the row IS the feedback.
    if (acquirer) {
      return {
        docId: null,
        refusal: "already-held",
        restored: false,
        contentHash,
      };
    }
    const duplicateId = insertDuplicateDoc(
      profileId,
      file.name,
      mime,
      buffer.length,
      contentHash,
      existing.filename,
      existing.status,
      acquiredPortalId
    );
    revalidateRoute("/data");
    return landed(duplicateId, contentHash, restored);
  }

  // 1. The placeholder row (status 'processing') was reserved in the transaction
  //    above, so it already shows immediately.
  const docId = reserved.docId;

  // Audit the new-document upload (the document id only — never its contents).
  recordAudit({
    loginId,
    profileId,
    action: AUDIT_ACTIONS.medicalDocUpload,
    target: String(docId),
  });

  // 2. Persist the original file to disk, under a per-profile subdirectory so one
  //    profile's uploads never share a folder with another's. stored_path is
  //    per-row, so pre-existing flat files (data/uploads/medical/<file>) need no
  //    migration — only new files land under the profile dir. The serve route's
  //    path-containment check accepts both shapes (both resolve inside the root).
  // Hoisted out of the try so the background dispatch below can pass the stored
  // PATH (re-read from disk in the job) instead of closing over the buffer (#135
  // item 2).
  let storedRelPath = "";
  try {
    storedRelPath = persistUploadedFile(profileId, docId, file.name, buffer);
  } catch (err) {
    // Log loudly with context (a full/read-only disk — ENOSPC/EROFS — surfaces
    // here) so the operator sees the real cause, but hand the user a friendly
    // message on the row instead of an unhandled 500.
    log.error("medical upload: could not persist file to disk", {
      docId,
      profile: profileId,
      err: err instanceof Error ? err : String(err),
    });
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(`Could not save file: ${errMsg(err)}`, docId, profileId);
    revalidateRoute("/data");
    return landed(docId, contentHash, restored);
  }

  // 3. Import. A health record (CCD/XDM/SHC) is parsed deterministically (no AI):
  //    small files inline (lands 'done' at once), large ones deferred so the
  //    upload returns immediately. Everything else runs AI extraction in the
  //    background (do NOT await) so the upload returns now; on a server restart,
  //    orphaned 'processing' docs are reset in migrate(). The AI-log context
  //    carries this session's login/profile into the background extraction.
  if (healthKind) {
    runHealthImport(profileId, docId, buffer);
    return landed(docId, contentHash, restored);
  }
  dispatchExtraction(
    loginId,
    profileId,
    docId,
    storedRelPath,
    storedMime,
    file.name
  );

  // The doc row (status 'processing') is now visible; the page polls from here.
  revalidateRoute("/data");
  return landed(docId, contentHash, restored);
}

// Above this size, a deterministic health-record parse+persist is pushed off the
// request instead of running inline. The parse is synchronous (better-sqlite3 +
// fast-xml-parser), so deferring doesn't free the event loop *during* the parse —
// but it lets the HTTP response return first with the row shown 'processing', and
// the extraction poller refreshes it when it flips to 'done'. (A worker thread
// would be needed to also unblock the loop for very large files — a follow-up.)
const HEALTH_SYNC_MAX_BYTES = 1_000_000;

// Run a deterministic health-record import, inline for small files and deferred
// for large ones. The document row already exists and is marked 'processing'.
// `after` runs the caller's revalidation (and any cleanup) once the import lands.
function runHealthImport(
  profileId: number,
  docId: number,
  buffer: Buffer,
  after: () => void = revalidateAfterHealthImport
) {
  if (buffer.length <= HEALTH_SYNC_MAX_BYTES) {
    persistHealthRecordDoc(profileId, docId, buffer);
    after();
    return;
  }
  // Defer past the current request; persistHealthRecordDoc records parse errors
  // on the row itself, so this only guards against an unexpected throw.
  setImmediate(() => {
    try {
      persistHealthRecordDoc(profileId, docId, buffer);
    } catch (err) {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
      ).run(`Import crashed: ${errMsg(err)}`, docId, profileId);
    }
    try {
      after();
    } catch {
      // Revalidate can reject outside request scope — the poller refreshes anyway.
    }
  });
  // Show the 'processing' row immediately; the poller picks up the flip to 'done'.
  revalidateRoute("/data");
}

// Revalidate everything a deterministic health-record import can touch (records,
// immunizations, titers, and — when demographics were adopted — settings).
function revalidateAfterHealthImport() {
  revalidateRoute("/data");
  revalidateRoute("/records");
  revalidateRoute("/results");
  revalidateRoute("/settings");
  revalidateRoute("/settings/health");
  revalidateRoute("/");
}

// Background extraction: call the AI, then import all results and finalize the
// document's status/metadata in a single transaction. The page polls for the
// status flip (processing → done/failed) while this runs. Idempotent: on a
// successful extraction it replaces the document's existing records, so it
// doubles as the reprocess path (a fresh upload simply has none to replace).
// Returns the final status so callers (e.g. reprocess) can tally results.
//
// `charged` (#135 item 3): whether the caller consumed a daily extraction unit for
// this run (true when an API key was present at dispatch). On a TRANSIENT `failed`
// outcome — a model timeout/429/5xx or a crash mid-run — the unit is refunded, so a
// flaky evening no longer permanently exhausts the profile's cap with nothing
// imported. A `skipped` outcome is never refunded (a deliberate decline), and a
// no-key run (`charged=false`) was never charged, so nothing is handed back. The
// refund lands on the profile's local day, matching the charge (they share the same
// process tick — extraction settles within minutes, on the same local date).
export async function runExtraction(
  profileId: number,
  docId: number,
  buffer: Buffer,
  mime: string,
  filename: string,
  charged: boolean = false,
  // The acting login, threaded so the post-import daily-insight regeneration
  // formats weights/distances in the reader's unit preference instead of the
  // canonical kg/km fallback (issue #632). Absent for background contexts with
  // no reader (falls back to kg/km, matching the pre-#632 behavior).
  loginId?: number
): Promise<"done" | "failed" | "skipped"> {
  let result: ExtractionResult;
  try {
    // Pass the known canonical vocabulary so the model reuses existing names
    // (cross-document consistency from the very first document).
    //
    // Inside the try on purpose: getCanonicalVocabulary() is a synchronous DB read
    // that can throw (SQLITE_BUSY), and callers do NOT all handle a rejection —
    // reprocessDocumentById's catch only knows QueueFullError, and reprocessOne
    // rethrows into reprocessAllForProfile's untried loop. A throw escaping here
    // would leave the row stuck 'processing' with its charged unit unrefunded, and
    // abort a bulk reprocess mid-way. This function must always resolve to a status.
    result = await extractMedicalDocument(
      buffer,
      mime,
      filename,
      getCanonicalVocabulary()
    );
  } catch (err) {
    return failCrashed(profileId, docId, filename, charged, err);
  }
  return persistExtractionResult(
    profileId,
    docId,
    result,
    filename,
    charged,
    loginId
  );
}

// The crash path: mark the document 'failed' and hand back a charged unit. Shared
// by the extract call and the persist tail so a throw anywhere in a run has ONE
// terminal outcome — a document must never be left mid-flight on 'processing', and
// a crash is transient from the quota's view (#135 item 3).
function failCrashed(
  profileId: number,
  docId: number,
  filename: string,
  charged: boolean,
  err: unknown
): "failed" {
  log.error("import/runner crashed", { docId, filename, err });
  db.prepare(
    "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
  ).run(`Extraction crashed: ${errMsg(err)}`, docId, profileId);
  if (charged) refundAiUsage(profileId, "extraction");
  return "failed";
}

// Apply an ExtractionResult to its document: honor the status, reduce a successful
// one to the shared persist shape, write it through the one persist core, and run
// the post-commit follow-ups.
//
// Split out of runExtraction (#903) so the AI path and the re-import of a stored
// raw_extraction (reprocessFromRawById) share ONE tail — the delete-set, the doc
// finalize, and the follow-ups can't drift between "extracted just now" and
// "re-normalized from what we saved", exactly as the CCD and AI paths already
// share persistDocumentImport.
//
// `charged` says whether the caller consumed a daily AI unit for this run: a
// transient failure refunds it (#135 item 3). The raw path is never charged (no
// model call), so it passes false and nothing is refunded.
async function persistExtractionResult(
  profileId: number,
  docId: number,
  result: ExtractionResult,
  filename: string,
  charged: boolean,
  loginId?: number
): Promise<"done" | "failed" | "skipped"> {
  try {
    if (result.status === "done") {
      log.info("importing extracted records", {
        docId,
        filename,
        records: result.results.length,
      });
    } else {
      log.info("extraction not imported", {
        docId,
        filename,
        status: result.status,
        reason: result.status === "skipped" ? result.message : result.error,
      });
    }

    // On skip/fail we leave any existing records in place (don't destroy data on
    // a failed reprocess); only a successful extraction replaces them below.
    if (result.status === "skipped") {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
      ).run(result.message, docId, profileId);
      return "skipped";
    }
    if (result.status === "failed") {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
      ).run(result.error, docId, profileId);
      // Transient model failure — refund the consumed unit (#135 item 3).
      if (charged) refundAiUsage(profileId, "extraction");
      return "failed";
    }

    // Reduce the AI extraction to the shared persist shape and write it through
    // the one persist core (lib/import-persist) that the deterministic
    // health-record path also uses, so the delete-set / insert columns / doc
    // finalize can't drift between the two. The fallback date (document date,
    // else today in the profile's timezone) is resolved here because it needs
    // today(profileId); results with a real collected_date keep it.
    const fallbackDate =
      (isIsoDate(result.meta.document_date) && result.meta.document_date) ||
      today(profileId);
    const input = extractionToPersistInput(result, fallbackDate);
    commitPersistInput(profileId, docId, input, filename, loginId);
    return "done";
  } catch (err) {
    // A crash mid-run marks the row and refunds a charged unit (#135 item 3).
    return failCrashed(profileId, docId, filename, charged, err);
  }
}

// Write a fully-reduced PersistInput to its document through the one persist core
// (lib/import-persist — the delete-set + insert + doc finalize) and run the
// best-effort post-commit follow-ups (profile backfill, canonical names, flag
// reconciliation, revalidation, auto-suggest). Shared by the fresh-extraction
// commit (persistExtractionResult) AND the apply-the-previewed-input path
// (issue #946), so a committed preview and a fresh extraction traverse the SAME
// import-footprint chokepoints and follow-ups — they can't drift. Throws only from
// persistDocumentImport (the atomic write); the follow-ups are swallowed, so a
// follow-up failure never un-finalizes a document whose data is already committed.
function commitPersistInput(
  profileId: number,
  docId: number,
  input: PersistInput,
  filename: string,
  loginId?: number
): void {
  const { insertedRecordIds: insertedIds } = persistDocumentImport(
    profileId,
    docId,
    input
  );

  // The import transaction has committed and the document is durably marked
  // 'done'. The post-commit steps below are best-effort follow-ups — a throw here
  // must NOT flip the document back to 'failed' after its data is already
  // imported. Log and swallow instead.
  try {
    // Backfill the profile (sex/birthdate/age) when unset, register canonical
    // names, and reconcile flags — the shared follow-ups both import paths run.
    const adopted = applyImportFollowups(profileId, {
      demographics: input.demographics,
      canonicalNames: input.canonicalNamesToRegister,
      insertedRecordIds: insertedIds,
      records: input.records,
    });
    if (adopted.bloodType) {
      log.info("adopted blood type from document", {
        docId,
        bloodType: adopted.bloodType,
      });
    }
    if (adopted.sexAdopted) {
      log.info("adopted user sex from document", {
        docId,
        sex: input.demographics?.patient_sex ?? null,
      });
    }
    if (adopted.birthdate) {
      log.info("adopted user birthdate from document", {
        docId,
        birthdate: adopted.birthdate,
      });
    }
    if (adopted.age !== null) {
      log.info("adopted user age from document", { docId, age: adopted.age });
    }
    if (adopted.fullName) {
      log.info("adopted user full name from document", { docId });
    }
    if (adopted.changed) revalidateRoute("/settings");
    revalidateRoute("/results");
    // Imported body metrics surface on Body Metrics and the dashboard.
    revalidateRoute("/trends");
    revalidateRoute("/");
    // Fire-and-forget AI recommendation run from the new/changed biomarkers
    // (issue #424 — the generalized auto-suggest hook), so extraction latency is
    // unchanged (the doc is already marked 'done'). Cadence-gated: no-ops when
    // the profile's cadence is off, AI is unconfigured, or the input signature is
    // unchanged. Inherits the ambient AI-log context set by the caller.
    void runRecommendation(profileId, {
      trigger: "document-imported",
      recordIds: insertedIds,
      // Thread the reader's login (issue #632) so the regenerated insight's PRs
      // and weight-trend deltas render in their lb/mi preference, matching the
      // scheduled first-page-view trigger; absent → the kg/km fallback.
      loginId,
    })
      .then(() => {
        revalidateRoute("/nutrition");
        revalidateRoute("/medications");
      })
      .catch((err) => log.error("recommendation run failed", { docId, err }));
  } catch (err) {
    log.error("post-import steps failed (document already imported)", {
      docId,
      filename,
      err,
    });
  }
}

export interface ReprocessResult {
  status: "done" | "skipped";
  message: string;
}

// Synchronous prep shared by both reprocess paths: validate the document, claim
// it (atomically flip to 'processing'), and read its stored file from disk.
// Returns the bytes needed to run extraction, or a `{ status }` tag when there's
// nothing to run: 'missing' (no/unreadable stored file — already recorded on the
// row) or 'processing' (already claimed by a concurrent reprocess). Kept separate
// from the (async) extraction so the single-document action can claim now and run
// extraction in the background — see reprocessDocumentById.
function beginReprocess(
  profileId: number,
  docId: number
):
  | { buffer: Buffer; mime: string; filename: string }
  | { status: "missing" | "processing" } {
  const d = db
    .prepare(
      "SELECT filename, stored_path, mime_type FROM medical_documents WHERE id = ? AND profile_id = ?"
    )
    .get(docId, profileId) as
    | { filename: string; stored_path: string | null; mime_type: string | null }
    | undefined;
  if (!d || !d.stored_path) {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run("No stored file — cannot reprocess.", docId, profileId);
    return { status: "missing" };
  }
  // Claim the document atomically: flip to 'processing' only if it isn't already,
  // so two concurrent reprocess calls can't both run extraction on the same row.
  // Shared with the duplicate-upload re-extraction path (issue #324) so the two
  // claims can't drift.
  if (!claimDocumentForExtraction(profileId, docId))
    return { status: "processing" }; // already in flight
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(path.join(process.cwd(), d.stored_path));
  } catch {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run("Stored file is missing — cannot reprocess.", docId, profileId);
    return { status: "missing" };
  }
  return {
    buffer,
    mime: d.mime_type || "application/octet-stream",
    filename: d.filename,
  };
}

// Reprocess one document and AWAIT the result: claim it, then run extraction
// (which replaces its records on success). Returns the resulting status
// ('processing' means it was already claimed by a concurrent call). Used by the
// bulk reprocess, which runs documents sequentially and tallies their outcomes.
// Does not revalidate or clean up stars — callers do.
export async function reprocessOne(
  profileId: number,
  docId: number,
  // Acting login, threaded into runExtraction so a reprocess-triggered insight
  // regeneration uses the reader's unit preference (issue #632).
  loginId?: number
): Promise<"done" | "failed" | "skipped" | "missing" | "processing"> {
  const prep = beginReprocess(profileId, docId);
  if ("status" in prep) return prep.status;
  // A health record (CCD/XDM/SHC) re-imports deterministically — no AI, no key.
  if (detectHealthRecord(prep.buffer))
    return persistHealthRecordDoc(profileId, docId, prep.buffer).status;
  if (!isTaskConfigured("extraction")) {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(
      "AI not configured — set ANTHROPIC_API_KEY or AI_BASE_URL to reprocess.",
      docId,
      profileId
    );
    return "skipped";
  }
  // Daily AI cap: with a key present this consumes an extraction unit; on
  // exhaustion the doc is marked 'skipped' (with the limit message) and we report
  // it so the bulk tally reflects the skip. Otherwise run through the concurrency
  // limiter (the caller already established the AI-log context).
  if (!allowExtractionDispatch(profileId, docId)) return "skipped";
  // Charged (key present + cap allowed), so a transient failure inside runExtraction
  // refunds the unit (#135 item 3). If the limiter's queue is saturated (#135 item
  // 2), shed to 'skipped' and refund rather than throwing out of the bulk loop.
  try {
    return await extractionSemaphore.run(() =>
      runExtraction(
        profileId,
        docId,
        prep.buffer,
        prep.mime,
        prep.filename,
        true,
        loginId
      )
    );
  } catch (err) {
    if (err instanceof QueueFullError) {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
      ).run(AI_QUEUE_FULL_DOC_MESSAGE, docId, profileId);
      refundAiUsage(profileId, "extraction");
      return "skipped";
    }
    throw err;
  }
}

function revalidateAfterReprocess() {
  revalidateRoute("/data");
  revalidateRoute("/import/[id]", "page");
  revalidateRoute("/results");
  revalidateRoute("/trends");
  revalidateRoute("/records");
  revalidateRoute("/");
}

// Preview the cost of "Re-extract all documents" BEFORE running it (issue #208):
// classify each reprocessable document as a deterministic health-record re-import
// (no AI) vs a scan/PDF AI extraction, and measure the AI count against the
// profile's remaining daily extraction quota. The confirm dialog formats this into
// a cost line and takes the skip-confirm fast path when no AI call is involved. The
// SAME `stored_path`/`processing` filter reprocessAllForProfile uses so the preview
// counts exactly the set that would run. Read-only — never touches the DB.
// Re-run AI extraction on every uploaded document and replace its imported
// records with the fresh results. This OVERWRITES any manual edits made to a
// document's records (manual standalone records are untouched). Runs the
// documents sequentially to stay within API rate limits.
export async function reprocessAllForProfile(
  loginId: number,
  profileId: number
): Promise<ReprocessResult> {
  // No blanket API-key gate: health-record documents (CCD/XDM/SHC) reprocess
  // deterministically without a key. reprocessOne marks any AI-only document
  // 'skipped' when the key is missing, so the tally still reflects it.
  // Exclude documents already being processed so a concurrent reprocess-all (or an
  // in-flight single reprocess) isn't double-run. reprocessOne's atomic claim is
  // the real guard against a race; this just avoids obvious redundant work.
  const ids = (
    db
      .prepare(
        "SELECT id FROM medical_documents WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != '' AND extraction_status != 'processing'"
      )
      .all(profileId) as { id: number }[]
  ).map((r) => r.id);
  if (ids.length === 0) {
    return { status: "done", message: "No uploaded documents to reprocess." };
  }

  let done = 0;
  let failed = 0;
  let missing = 0;
  let skipped = 0;
  for (const id of ids) {
    const status = await withAiLogContext({ loginId, profileId }, () =>
      reprocessOne(profileId, id, loginId)
    );
    if (status === "done") done++;
    else if (status === "missing") missing++;
    else if (status === "skipped") skipped++;
    else if (status === "processing")
      continue; // claimed by a concurrent call
    else failed++;
  }

  cleanupOrphanBiomarkerKeyedState(profileId);
  revalidateAfterReprocess();

  const parts = [`Reprocessed ${done} document${done === 1 ? "" : "s"}`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (missing) parts.push(`${missing} missing file${missing === 1 ? "" : "s"}`);
  return { status: "done", message: parts.join(", ") + "." };
}

// The apply outcome (issue #946), so the UI can tell the user whether it committed
// exactly what they previewed or fell back to a fresh (possibly different)
// re-extraction. `committed-preview` means the cached previewed input was persisted
// verbatim with NO model call; `re-extracted` means the direct path, or a fallback
// because the preview token was missing/expired/stale/superseded — the fresh
// extraction runs in the background and its result may differ from the preview.
export type ReprocessApplyOutcome =
  { mode: "committed-preview" } | { mode: "re-extracted" };

// A signature of the document row captured to detect that it changed between a
// preview and its apply (#946 / the #467 stale-form discipline). content_hash
// catches a replaced file; the raw_extraction + extracted_count + finalize columns
// are the "extraction generation" — they change when a concurrent reprocess
// re-imports the document. Hashed so a large raw_extraction stays a compact key.
// Null when the row is gone (deleted/reassigned under us).
function documentStalenessKey(profileId: number, docId: number): string | null {
  const d = db
    .prepare(
      `SELECT content_hash, stored_path, raw_extraction, extracted_count,
              document_date, source, model
         FROM medical_documents WHERE id = ? AND profile_id = ?`
    )
    .get(docId, profileId) as
    | {
        content_hash: string | null;
        stored_path: string | null;
        raw_extraction: string | null;
        extracted_count: number | null;
        document_date: string | null;
        source: string | null;
        model: string | null;
      }
    | undefined;
  if (!d) return null;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        d.content_hash,
        d.stored_path,
        d.raw_extraction,
        d.extracted_count,
        d.document_date,
        d.source,
        d.model,
      ])
    )
    .digest("hex");
}

// Try to commit a previously-previewed extraction (#946) instead of re-extracting.
// Returns "committed" (the cached input was persisted verbatim), "fallback" (token
// missing/expired/stale, or a concurrent reprocess owns the row — the caller should
// re-extract), or "failed-terminal" (the persist crashed AFTER claiming; the row is
// marked 'failed', so the caller must NOT re-dispatch). The token is single-use and
// profile-scoped: takePreviewInput consumes it only for the rightful owner.
function commitCachedPreview(
  loginId: number,
  profileId: number,
  id: number,
  previewToken: string
): "committed" | "fallback" | "failed-terminal" {
  const currentKey = documentStalenessKey(profileId, id);
  if (currentKey === null) return "fallback"; // row vanished — let the re-extract path record the miss
  const taken = takePreviewInput(profileId, id, previewToken, currentKey);
  if (!("input" in taken)) return "fallback"; // missing / expired / stale
  // Claim the row atomically so a concurrent reprocess can't also write it (#324).
  // A lost claim means an extraction is already in flight — fall back (which will
  // see 'processing' and no-op) rather than committing over it.
  if (!claimDocumentForExtraction(profileId, id)) return "fallback";
  const filename =
    (
      db
        .prepare(
          "SELECT filename FROM medical_documents WHERE id = ? AND profile_id = ?"
        )
        .get(id, profileId) as { filename: string } | undefined
    )?.filename ?? "document";
  try {
    // Commit the PREVIEWED input through the SAME persist core + follow-ups a fresh
    // extraction uses — the import-footprint chokepoints are unchanged. No model
    // call, so nothing is charged and nothing lands in the AI log for this apply.
    commitPersistInput(profileId, id, taken.input, filename, loginId);
    cleanupOrphanBiomarkerKeyedState(profileId);
    revalidateAfterReprocess();
    return "committed";
  } catch (err) {
    // The persist crashed after the claim — the row is 'processing'; mark it
    // terminally 'failed' so it isn't wedged, and report failed-terminal so the
    // caller doesn't then pay for a re-extraction on top.
    failCrashed(profileId, id, filename, false, err);
    revalidateAfterReprocess();
    return "failed-terminal";
  }
}

// Reprocess a single document. Overwrites that document's records. Mirrors the
// upload path: flip the document to 'processing' and run extraction in the
// BACKGROUND (do NOT await) so the caller returns immediately. Awaiting the AI
// call would keep the client's transition pending for its entire duration,
// freezing the page. The app-wide ExtractionToaster poller refreshes the page and
// toasts once the background job finishes; the row shows a spinner (status
// 'processing') in the meantime.
//
// When `previewToken` is supplied (the reprocess-with-preview apply, #946), the
// cached previewed input is committed VERBATIM — zero extra extractions, no consent
// drift. A missing/expired/stale token degrades to the re-extract below and the
// returned outcome says `re-extracted` so the UI can note the divergence. The
// direct no-preview path (no token) is untouched: always a fresh re-extraction.
export function reprocessDocumentById(
  loginId: number,
  profileId: number,
  id: number,
  previewToken?: string
): ReprocessApplyOutcome {
  if (previewToken) {
    const committed = commitCachedPreview(loginId, profileId, id, previewToken);
    if (committed === "committed") return { mode: "committed-preview" };
    if (committed === "failed-terminal") return { mode: "re-extracted" };
    // "fallback" — the token didn't apply; drop through to a fresh re-extraction.
  }
  // We're about to re-extract and replace this document's rows, so any lingering
  // previewed input for it is now moot — evict it (delete/reassign evict at their
  // own actions; every persist path evicts via persistDocumentImport).
  evictPreviewsForDocument(profileId, id);
  const prep = beginReprocess(profileId, id);
  if ("status" in prep) {
    // Nothing to run — missing file (status already recorded) or already claimed
    // by a concurrent reprocess. Just refresh to show the current status.
    revalidateAfterReprocess();
    return { mode: "re-extracted" };
  }
  // A health record (CCD/XDM/SHC) re-imports deterministically — no AI, no key.
  // Small files run inline; large ones defer so the action returns immediately.
  if (detectHealthRecord(prep.buffer)) {
    runHealthImport(profileId, id, prep.buffer, () => {
      cleanupOrphanBiomarkerKeyedState(profileId);
      revalidateAfterReprocess();
    });
    return { mode: "re-extracted" };
  }
  if (!isTaskConfigured("extraction")) {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(
      "AI not configured — set ANTHROPIC_API_KEY or AI_BASE_URL to reprocess.",
      id,
      profileId
    );
    revalidateAfterReprocess();
    return { mode: "re-extracted" };
  }
  // Daily AI cap: consume an extraction unit (key is present here). On exhaustion
  // the doc is marked 'skipped' with the limit message — refresh and return, don't
  // dispatch.
  if (!allowExtractionDispatch(profileId, id)) {
    revalidateAfterReprocess();
    return { mode: "re-extracted" };
  }
  // Fire-and-forget. runExtraction catches its own errors and marks the row, so
  // this never rejects; clean up orphaned stars and revalidate once it settles.
  // withAiLogContext carries the acting login/profile tags into the background
  // extraction via AsyncLocalStorage, and the concurrency limiter caps how many
  // extractions run at once. The trailing revalidate can reject when it fires
  // outside request scope — swallow it, the toaster poller refreshes anyway.
  void withAiLogContext({ loginId, profileId }, () =>
    extractionSemaphore.run(() =>
      // charged=true — key present + cap allowed, so a transient failure refunds
      // the unit (#135 item 3).
      runExtraction(
        profileId,
        id,
        prep.buffer,
        prep.mime,
        prep.filename,
        true,
        loginId
      )
    )
  )
    .then(() => {
      cleanupOrphanBiomarkerKeyedState(profileId);
      revalidateAfterReprocess();
    })
    .catch((err) => {
      // Shed the job if the limiter's queue is saturated (#135 item 2): mark
      // 'skipped' (reprocessable) and refund; otherwise log the unexpected reject.
      if (err instanceof QueueFullError) {
        db.prepare(
          "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
        ).run(AI_QUEUE_FULL_DOC_MESSAGE, id, profileId);
        refundAiUsage(profileId, "extraction");
        revalidateAfterReprocess();
        return;
      }
      log.error("post-reprocess refresh failed", { id, err });
    });
  // Return now with the document marked 'processing' so the page swaps the
  // reprocess button for a spinner instead of blocking on the AI call.
  revalidateAfterReprocess();
  return { mode: "re-extracted" };
}

export interface ReprocessFromRawResult {
  status: "done" | "skipped" | "failed";
  message: string;
}

// Re-import a document from its STORED raw extraction (#903): re-run the
// normalize + persist half of the pipeline against the model output already saved
// on the row — NO model call, no API key required, no daily-quota unit consumed.
//
// This is the right tool whenever the bug was in OUR parsing rather than in the
// model's answer. #902 is the motivating case: a payload the model nested under an
// envelope key imported as ZERO records, and the only recovery was paying for a
// full re-extraction — which is slower, costs a unit, and can return different
// data. The saved extraction is the same answer; it just needed parsing correctly.
//
// Unlike the AI reprocess this runs INLINE and is awaited: with no model call
// there's nothing slow to background, so the caller gets the real outcome instead
// of a 'processing' spinner. Documents imported deterministically (CCD/XDM/SHC/
// FHIR) carry no raw_extraction — they have nothing to replay and report 'skipped'.
export async function reprocessFromRawById(
  loginId: number,
  profileId: number,
  id: number
): Promise<ReprocessFromRawResult> {
  const d = db
    .prepare(
      "SELECT filename, raw_extraction, model FROM medical_documents WHERE id = ? AND profile_id = ?"
    )
    .get(id, profileId) as
    | { filename: string; raw_extraction: string | null; model: string | null }
    | undefined;
  if (!d) return { status: "skipped", message: "Unknown document." };
  const raw = (d.raw_extraction ?? "").trim();
  if (!raw)
    return {
      status: "skipped",
      message:
        "No saved AI extraction for this document — re-extract it instead. (Health records import deterministically and have none.)",
    };
  // Claim the row so this can't race a concurrent reprocess — the same atomic
  // claim the AI paths use (#324).
  if (!claimDocumentForExtraction(profileId, id))
    return {
      status: "skipped",
      message: "This document is already processing — try again in a moment.",
    };

  // A stored extraction that can't be parsed/recognized leaves the existing rows
  // ALONE (same discipline as a failed re-extraction: never destroy data on a
  // failure) and records why on the row.
  const fail = (reason: string, message: string): ReprocessFromRawResult => {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(reason, id, profileId);
    revalidateAfterReprocess();
    return { status: "failed", message };
  };

  let input: unknown;
  try {
    input = unwrapExtractionInput(JSON.parse(raw));
  } catch (err) {
    log.error("raw reprocess: saved extraction is not valid JSON", { id, err });
    return fail(
      `Saved extraction is not valid JSON: ${errMsg(err)}`,
      "The saved extraction could not be parsed — re-extract this document."
    );
  }
  if (!looksLikeExtractionInput(input))
    return fail(
      "Saved extraction is in an unrecognized shape.",
      "The saved extraction is in an unrecognized shape — re-extract this document."
    );

  // Everything past the CLAIM runs inside a try: the row is now 'processing', and a
  // throw escaping here would wedge it there — unreachable by this path (the claim
  // would fail) AND excluded from reprocessAllForProfile (which skips 'processing'),
  // leaving only the reaper to clear it. getCanonicalVocabulary() is a synchronous
  // DB read that can throw (SQLITE_BUSY), so this is a live surface, not a
  // formality. Every exit from here must be terminal.
  try {
    // Preserve the ORIGINAL model attribution read off the row: this is a replay of
    // that model's answer, not a fresh run of the current one.
    const result = resultFromExtractionInput(
      input,
      getCanonicalVocabulary(),
      d.model ?? ""
    );
    const status = await withAiLogContext({ loginId, profileId }, () =>
      persistExtractionResult(profileId, id, result, d.filename, false, loginId)
    );
    cleanupOrphanBiomarkerKeyedState(profileId);
    revalidateAfterReprocess();
    if (status !== "done")
      return {
        status: "failed",
        message:
          "Re-import from the saved extraction failed — see the document.",
      };
    return {
      status: "done",
      message: `Re-imported ${result.results.length} record(s) from the saved extraction — no AI call.`,
    };
  } catch (err) {
    log.error("raw reprocess crashed", { id, err });
    // Never charged (no model call), so nothing to refund — just leave the row in a
    // terminal state with the reason on it.
    return fail(
      `Re-import from the saved extraction crashed: ${errMsg(err)}`,
      "Re-import from the saved extraction failed — see the document."
    );
  }
}

// Re-extract a stored document to an in-memory PersistInput WITHOUT writing
// anything (reprocess-diff). This is the read-only twin of the
// reprocess writers: it reads the stored file and runs the same parse/extract the
// commit path would, but returns the shape instead of persisting it — so a diff
// preview can compare it against the currently-persisted rows and only the
// confirm step (reprocessDocumentById, unchanged) actually mutates the DB. Returns
// a `skip` reason when there's nothing to diff (no file, unsupported without a key,
// or the extraction skipped/failed).
async function extractPersistInputForPreview(
  profileId: number,
  docId: number
): Promise<{ input: PersistInput } | { skip: string }> {
  const d = db
    .prepare(
      "SELECT filename, stored_path, mime_type FROM medical_documents WHERE id = ? AND profile_id = ?"
    )
    .get(docId, profileId) as
    | { filename: string; stored_path: string | null; mime_type: string | null }
    | undefined;
  if (!d || !d.stored_path) return { skip: "No stored file — cannot preview." };
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(path.join(process.cwd(), d.stored_path));
  } catch {
    return { skip: "Stored file is missing — cannot preview." };
  }

  // Deterministic health record (CCD/XDM/SHC): parse + snap canonical names
  // exactly as persistHealthRecordDoc does, but stop at the PersistInput — no write.
  if (detectHealthRecord(buffer)) {
    try {
      const { parsed, source } = parseHealthRecord(buffer);
      const canonicalIndex = buildCanonicalIndex(getCanonicalVocabulary());
      for (const r of parsed.records) {
        // Batch-aware, exactly as persistHealthRecordDoc snaps — the preview must
        // collapse same-key spellings the same way the commit will.
        r.canonical = snapCanonicalNameIntoBatch(
          distinguishVitaminDIsoform(r.canonical, r.name),
          canonicalIndex
        );
      }
      const SOURCE_LABEL: Record<string, string> = {
        ccda: "MyChart export (CCD/XDM)",
        "smart-health-card": "SMART Health Card",
        fhir: "FHIR export",
      };
      return {
        input: healthRecordToPersistInput(
          parsed,
          source,
          SOURCE_LABEL[source] ?? "Health record"
        ),
      };
    } catch (err) {
      return { skip: `Could not parse the file: ${errMsg(err)}` };
    }
  }

  // AI path: needs a key. Run the model to an in-memory result and reduce it to a
  // PersistInput (never persisted). A skip/fail has nothing to diff.
  if (!isTaskConfigured("extraction")) {
    return {
      skip: "AI not configured — set ANTHROPIC_API_KEY or AI_BASE_URL to preview a re-extraction.",
    };
  }
  // A preview re-extraction is a real Claude call, so it consumes the profile's
  // daily extraction quota like any other. On exhaustion, surface the existing
  // skip reason (read-only path — nothing to mark on a document row).
  if (
    !checkAndIncrementAiUsage(profileId, "extraction", extractionDailyLimit())
      .allowed
  ) {
    return {
      skip: "Daily AI limit reached — cannot preview a re-extraction today.",
    };
  }
  // Charged a unit above, so route the Claude call through the SAME process-wide
  // concurrency limiter every other extraction dispatch uses (#135 item 2) instead
  // of firing unbounded concurrent previews past AI_EXTRACTION_CONCURRENCY. A
  // saturated queue sheds to a skip + refund like the sibling reprocess paths.
  let result: Awaited<ReturnType<typeof extractMedicalDocument>>;
  try {
    result = await extractionSemaphore.run(() =>
      extractMedicalDocument(
        buffer,
        d.mime_type || "application/octet-stream",
        d.filename,
        getCanonicalVocabulary()
      )
    );
  } catch (err) {
    if (err instanceof QueueFullError) {
      refundAiUsage(profileId, "extraction");
      return { skip: AI_QUEUE_FULL_DOC_MESSAGE };
    }
    throw err;
  }
  if (result.status !== "done") {
    // A transient model failure (timeout/429/5xx) refunds the charged unit exactly
    // as runExtraction does (#135 item 3) — a flaky preview must not permanently burn
    // the profile's daily extraction quota. A deterministic `skipped` (unextractable
    // doc) legitimately consumes the unit, matching runExtraction's non-refund there.
    if (result.status === "failed") refundAiUsage(profileId, "extraction");
    return {
      skip:
        result.status === "skipped"
          ? `Extraction skipped: ${result.message}`
          : `Extraction failed: ${result.error}`,
    };
  }
  const fallbackDate =
    (isIsoDate(result.meta.document_date) && result.meta.document_date) ||
    today(profileId);
  return { input: extractionToPersistInput(result, fallbackDate) };
}

export type PreviewReprocessResult =
  // `previewToken` (issue #946) rides back so the apply can commit THIS previewed
  // input verbatim instead of re-extracting a second, possibly-different result.
  | { status: "ok"; diff: ImportDiff; previewToken: string }
  | { status: "skipped"; message: string };

// Preview what a reprocess would change: re-extract to an in-memory PersistInput,
// diff it against the currently-persisted rows, and return the diff WITHOUT
// touching the DB. The client shows the diff, then calls reprocessDocumentById
// with the returned `previewToken` (issue #946) to commit THIS exact input — no
// second extraction. The apply falls back to a fresh re-extract (and says so) if
// the token has expired or the document changed underneath the preview.
export async function previewReprocessById(
  loginId: number,
  profileId: number,
  id: number
): Promise<PreviewReprocessResult> {
  // Guard the id against another profile before reading its file.
  if (!getMedicalDocument(profileId, id)) {
    return { status: "skipped", message: "Unknown document." };
  }
  const extracted = await withAiLogContext({ loginId, profileId }, () =>
    extractPersistInputForPreview(profileId, id)
  );
  if ("skip" in extracted)
    return { status: "skipped", message: extracted.skip };
  // Enrich the fresh extraction with the flags the post-commit reconcile will
  // derive (age-banded vitals, optimal bands, titer immunity) — the persisted side
  // carries them, so without this every derived flag reads as a phantom change on
  // a byte-identical reprocess. Runs BEFORE the stash so the previewed input and
  // the committed input are the same object state.
  previewReconcileFlags(profileId, extracted.input.records);
  const current = getReprocessSnapshot(profileId, id);
  const next = snapshotFromPersistInput(extracted.input);
  // Consolidated medications (#1204): a derived drug the profile already tracks
  // under another document persists as renewal courses, not a new item — fold
  // those into the persisted side so they don't preview as phantom additions.
  foldConsolidatedMedsIntoSnapshot(
    profileId,
    current,
    next.medications,
    extracted.input.records
  );
  // Deferred body metrics / height / head-circ: a weight, resting-HR, height, or
  // head-circ that a reprocess would DEFER (another source already covers that date's
  // measure) is proposed by the defer-blind fresh snapshot, so it reads as a phantom
  // "add" on every reprocess. Prune those from `next` so an unchanged document previews
  // as unchanged.
  pruneDeferredMetricsFromSnapshot(profileId, id, next, extracted.input);
  // Stash the reduced input under a single-use token so the confirmed apply commits
  // exactly what the user is reviewing. The staleness key pins the document row's
  // current state; the apply refuses the cached input if it has since changed.
  const previewToken = stashPreviewInput({
    profileId,
    docId: id,
    input: extracted.input,
    stalenessKey: documentStalenessKey(profileId, id) ?? "",
  });
  return {
    status: "ok",
    diff: computeImportDiff(current, next),
    previewToken,
  };
}

// Record a rejected duplicate upload as a 'skipped' row (no file stored) so the
// user is alerted in the documents list. We still persist content_hash so the
// row is self-describing, and name the original file it duplicates. When that
// original hasn't successfully imported (e.g. its extraction failed), point the
// user at reprocessing it rather than re-uploading.
// Returns the id of the row it lands, so ingestMedicalUpload can hand every
// caller a document to point at (the share-target route redirects to it).
