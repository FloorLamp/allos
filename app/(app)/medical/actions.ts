"use server";
import {
  requireSession,
  requireWriteAccess,
  getAccessibleProfiles,
  accessForProfile,
} from "@/lib/auth";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import { isRealIsoDate } from "@/lib/date";
import type { MedicalCategory } from "@/lib/types";
import { extractMedicalDocument, isSupportedFile } from "@/lib/medical-extract";
import { sniffUploadType } from "@/lib/file-sniff";
import { aiConfigured } from "@/lib/ai-client";
import { withAiLogContext } from "@/lib/ai-log";
import {
  checkAndIncrementAiUsage,
  extractionDailyLimit,
  refundAiUsage,
} from "@/lib/ai-usage";
import { extractionSemaphore, QueueFullError } from "@/lib/ai-concurrency";
import {
  reconcileFlags,
  getCanonicalVocabulary,
  getMedicalDocument,
  getReprocessSnapshot,
} from "@/lib/queries";
import { resolveProviderIdByName } from "@/lib/providers-db";
import { autoSuggestFromBiomarkers } from "@/lib/supplement-suggest";
import {
  extractionToPersistInput,
  healthRecordToPersistInput,
  type PersistInput,
} from "@/lib/import-shape";
import {
  persistDocumentImport,
  applyImportFollowups,
  clearImportedDocumentRows,
} from "@/lib/import-persist";
import {
  detectHealthRecord,
  persistHealthRecordDoc,
} from "@/lib/health-record-doc";
import { parseHealthRecord } from "@/lib/health-record-parse";
import {
  buildCanonicalIndex,
  snapCanonicalName,
  distinguishVitaminDIsoform,
} from "@/lib/canonical-name";
import { documentSource } from "@/lib/body-metric-extract";
import {
  snapshotFromPersistInput,
  computeImportDiff,
  type ImportDiff,
} from "@/lib/import-diff";
import { canReassignDocument } from "@/lib/import-reassign";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";

const log = createLogger("medical");

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads", "medical");
const MAX_BYTES = 32 * 1024 * 1024; // 32MB (Anthropic request cap)

const MEDICAL_CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
];
const MEDICAL_FLAGS = ["normal", "high", "low", "abnormal"];

// Model-supplied dates are only *asked* to be ISO — validate before storing so a
// hallucinated "Friday" or "2026-13-45" can't land in a YYYY-MM-DD column.
// isRealIsoDate checks calendar validity too, not just the shape.
const isIsoDate = isRealIsoDate;

// Revalidate the import document pages plus the biomarkers surfaces after a
// record mutation, so edits made on /import/[id] also reflect on the records
// browser (/biomarkers) and per-biomarker detail pages, and vice versa.
function revalidateMedical() {
  revalidatePath("/data");
  revalidatePath("/import/[id]", "page");
  revalidatePath("/biomarkers");
  revalidatePath("/biomarkers/view", "page");
  revalidatePath("/immunizations");
  // The dashboard renders StarredBiomarkers, so a record mutation must refresh
  // it too (a new/edited/deleted reading changes a pinned biomarker's tile).
  revalidatePath("/");
}

// Light sanitation for a user-entered canonical name: trim, collapse internal
// whitespace, and cap length. Intentionally not hard-validated — legitimate
// biomarker names are diverse. Returns null when blank.
function sanitizeCanonical(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return v || null;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "upload"
  );
}

export async function addRecord(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  const category = String(formData.get("category")) as MedicalCategory;
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date) || !name) return;
  const value = (formData.get("value") as string)?.trim() || null;
  // Derive value_num from a purely-numeric value so manual readings chart.
  const valueNum =
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  // Default the canonical name to the record's own name (its own group until
  // backfilled or edited). Manual entry never writes to canonical_biomarkers.
  const canonical =
    sanitizeCanonical(formData.get("canonical_name") as string) ?? name;
  // Insert the record and reconcile its flag in one transaction, so a throw in
  // reconcileFlags can't leave a half-written record (matches persistDocumentImport).
  const write = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (date, category, name, value, value_num, unit, reference_range, notes, canonical_name, profile_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        date,
        category,
        name,
        value,
        valueNum,
        (formData.get("unit") as string)?.trim() || null,
        (formData.get("reference_range") as string)?.trim() || null,
        (formData.get("notes") as string)?.trim() || null,
        canonical,
        profile.id
      );
    // Auto-flag the new reading non-optimal if it falls outside the optimal band.
    reconcileFlags(profile.id, [Number(info.lastInsertRowid)]);
  });
  write();
  revalidateMedical();
}

// Edit a single extracted/manual record (used on the document subpage).
export async function updateRecord(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const date = String(formData.get("date") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date) || !name) return;

  const str = (k: string) => {
    const v = (formData.get(k) as string | null)?.trim();
    return v ? v : null;
  };
  const categoryRaw = String(formData.get("category") ?? "");
  const category = MEDICAL_CATEGORIES.includes(categoryRaw)
    ? categoryRaw
    : "lab";
  const flagRaw = str("flag");
  const flag = flagRaw && MEDICAL_FLAGS.includes(flagRaw) ? flagRaw : null;
  const value = str("value");
  // Keep value_num in sync so charts/aggregates stay correct.
  const valueNum =
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  // Canonical name: sanitized, defaulting to the record's name when blank so a
  // cleared field re-groups the record under itself (editable + reversible).
  const canonical = sanitizeCanonical(str("canonical_name")) ?? name;
  // Performing provider: resolve the typed name into the shared
  // GLOBAL registry (create-on-type), or NULL when left blank.
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );

  db.prepare(
    `UPDATE medical_records
       SET date = ?, category = ?, name = ?, value = ?, value_num = ?, unit = ?,
           reference_range = ?, flag = ?, panel = ?, notes = ?, canonical_name = ?,
           provider_id = ?,
           -- Lock integration-imported rows (external_id set) against re-ingest so a
           -- hand-corrected vital isn't silently reverted by the next rolling window
           -- (issue #133). No-op for manual/document rows (external_id NULL).
           edited = CASE WHEN external_id IS NOT NULL THEN 1 ELSE edited END
     WHERE id = ? AND profile_id = ?`
  ).run(
    date,
    category,
    name,
    value,
    valueNum,
    str("unit"),
    str("reference_range"),
    flag,
    str("panel"),
    str("notes"),
    canonical,
    providerId,
    id,
    profile.id
  );
  // Re-derive the non-optimal flag for this row (the editor sets only clinical
  // flags; non-optimal follows the value vs the canonical optimal band).
  reconcileFlags(profile.id, [id]);
  revalidateMedical();
}

export async function deleteRecord(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Capture into the undo holding table and delete in one transaction (issue #30)
  // so the record can be restored from the toast.
  const undoId = captureDelete("biomarker-record", profile.id, id);
  // Deleting the last reading for a starred biomarker would leave the star
  // pointing at nothing (an empty pinned tile) — drop any now-orphaned stars.
  // NOTE (consciously scoped out of undo): a star orphan-cleaned here is NOT
  // re-created on Undo — the reading returns but the pinned-tile star stays gone.
  cleanupOrphanStars(profile.id);
  revalidateMedical();
  return { undoId };
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
  if (!aiConfigured()) return true;
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
  const charged = aiConfigured();
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
      return runExtraction(profileId, docId, buffer, mime, filename, charged);
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

// Upload a medical document and store it on disk, then kick off AI extraction
// in the background. The action returns as soon as the file is saved (status
// 'processing'), so the document appears immediately; the page polls until
// extraction finishes and imports its results.
export async function uploadMedicalDocument(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;

  const mime = file.type || "application/octet-stream";
  // Reject an oversized upload BEFORE buffering the whole file into memory —
  // file.size is known from the multipart headers, so we needn't read a 100MB
  // body just to reject it. The post-buffer check below is a backstop.
  if (file.size > MAX_BYTES) {
    insertFailedDoc(
      profile.id,
      file.name,
      mime,
      file.size,
      `File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)}MB).`
    );
    revalidatePath("/data");
    return;
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  // A MyChart CCD/XDM or SMART Health Card is imported deterministically (no AI);
  // everything else goes to the model, so it must be an AI-supported type.
  const healthKind = detectHealthRecord(buffer);
  if (!healthKind && !isSupportedFile(file.name, mime)) {
    insertFailedDoc(
      profile.id,
      file.name,
      mime,
      file.size,
      "Unsupported file type."
    );
    revalidatePath("/data");
    return;
  }
  // Backstop the pre-buffer size gate against a lying/absent file.size, now that
  // the actual byte length is known.
  if (buffer.length > MAX_BYTES) {
    insertFailedDoc(
      profile.id,
      file.name,
      mime,
      buffer.length,
      `File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)}MB).`
    );
    revalidatePath("/data");
    return;
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
    insertFailedDoc(profile.id, file.name, mime, buffer.length, typed.reason);
    revalidatePath("/data");
    return;
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
  // Do the dedup check and the placeholder-row insert atomically in one
  // transaction so two simultaneous uploads of the same bytes can't both pass the
  // check and both insert (better-sqlite3 is synchronous, so this closes the race
  // within the process). The transaction returns either the pre-existing row or
  // the id of the freshly reserved 'processing' row; file IO / extraction happen
  // afterwards, outside the transaction.
  type Existing = {
    id: number;
    filename: string;
    status: string;
    stored_path: string | null;
  };
  const findExisting = db.prepare(
    `SELECT id, filename, extraction_status AS status, stored_path
       FROM medical_documents
      WHERE content_hash = ? AND profile_id = ?
      ORDER BY (stored_path IS NULL OR stored_path = ''), id
      LIMIT 1`
  );
  const insertRow = db.prepare(
    `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, content_hash, extraction_status, processing_started_at, profile_id)
     VALUES (?,?,?,?,?, 'processing', datetime('now'), ?)`
  );
  const reserve = db.transaction(
    (): { existing: Existing } | { docId: number } => {
      const found = findExisting.get(contentHash, profile.id) as
        Existing | undefined;
      if (found) return { existing: found };
      const info = insertRow.run(
        file.name,
        "",
        storedMime,
        buffer.length,
        contentHash,
        profile.id
      );
      return { docId: Number(info.lastInsertRowid) };
    }
  );
  const reserved = reserve();
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
      (healthKind || aiConfigured())
    ) {
      db.prepare(
        "UPDATE medical_documents SET extraction_status = 'processing', extraction_error = NULL, processing_started_at = datetime('now') WHERE id = ? AND profile_id = ?"
      ).run(existing.id, profile.id);
      if (healthKind) {
        runHealthImport(profile.id, existing.id, buffer);
      } else {
        // Re-read the stored file inside the job (#135 item 2) — pass the path, not
        // the bytes. existing.stored_path is guaranteed non-null by the guard above.
        dispatchExtraction(
          login.id,
          profile.id,
          existing.id,
          existing.stored_path,
          storedMime,
          existing.filename
        );
        revalidatePath("/data");
      }
      return;
    }
    insertDuplicateDoc(
      profile.id,
      file.name,
      mime,
      buffer.length,
      contentHash,
      existing.filename,
      existing.status
    );
    revalidatePath("/data");
    return;
  }

  // 1. The placeholder row (status 'processing') was reserved in the transaction
  //    above, so it already shows immediately.
  const docId = reserved.docId;

  // Audit the new-document upload (the document id only — never its contents).
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
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
    const profileDir = path.join(UPLOAD_DIR, String(profile.id));
    fs.mkdirSync(profileDir, { recursive: true });
    const stored = `${docId}-${safeName(file.name)}`;
    fs.writeFileSync(path.join(profileDir, stored), buffer);
    storedRelPath = path.join(
      "data",
      "uploads",
      "medical",
      String(profile.id),
      stored
    );
    db.prepare(
      "UPDATE medical_documents SET stored_path = ? WHERE id = ? AND profile_id = ?"
    ).run(storedRelPath, docId, profile.id);
  } catch (err) {
    // Log loudly with context (a full/read-only disk — ENOSPC/EROFS — surfaces
    // here) so the operator sees the real cause, but hand the user a friendly
    // message on the row instead of an unhandled 500.
    log.error("medical upload: could not persist file to disk", {
      docId,
      profile: profile.id,
      err: err instanceof Error ? err : String(err),
    });
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(`Could not save file: ${errMsg(err)}`, docId, profile.id);
    revalidatePath("/data");
    return;
  }

  // 3. Import. A health record (CCD/XDM/SHC) is parsed deterministically (no AI):
  //    small files inline (lands 'done' at once), large ones deferred so the
  //    upload returns immediately. Everything else runs AI extraction in the
  //    background (do NOT await) so the upload returns now; on a server restart,
  //    orphaned 'processing' docs are reset in migrate(). The AI-log context
  //    carries this session's login/profile into the background extraction.
  if (healthKind) {
    runHealthImport(profile.id, docId, buffer);
    return;
  }
  dispatchExtraction(
    login.id,
    profile.id,
    docId,
    storedRelPath,
    storedMime,
    file.name
  );

  // The doc row (status 'processing') is now visible; the page polls from here.
  revalidatePath("/data");
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
  revalidatePath("/data");
}

// Revalidate everything a deterministic health-record import can touch (records,
// immunizations, titers, and — when demographics were adopted — settings).
function revalidateAfterHealthImport() {
  revalidatePath("/data");
  revalidatePath("/immunizations");
  revalidatePath("/biomarkers");
  revalidatePath("/settings");
  revalidatePath("/settings/profile");
  revalidatePath("/");
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
async function runExtraction(
  profileId: number,
  docId: number,
  buffer: Buffer,
  mime: string,
  filename: string,
  charged: boolean = false
): Promise<"done" | "failed" | "skipped"> {
  try {
    // Pass the known canonical vocabulary so the model reuses existing names
    // (cross-document consistency from the very first document).
    const result = await extractMedicalDocument(
      buffer,
      mime,
      filename,
      getCanonicalVocabulary()
    );

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
    const { insertedRecordIds: insertedIds } = persistDocumentImport(
      profileId,
      docId,
      input
    );

    // The import transaction has committed and the document is durably marked
    // 'done'. The post-commit steps below (profile backfill, canonical names,
    // flag reconciliation, revalidation, auto-suggest) are best-effort follow-ups
    // — a throw here must NOT flip the document back to 'failed' after its data is
    // already imported. Log and swallow instead.
    try {
      // Backfill the profile (sex/birthdate/age) when unset, register canonical
      // names, and reconcile flags — the shared follow-ups both import paths run.
      const adopted = applyImportFollowups(profileId, {
        demographics: input.demographics,
        canonicalNames: input.canonicalNamesToRegister,
        insertedRecordIds: insertedIds,
      });
      if (adopted.sexAdopted) {
        log.info("adopted user sex from document", {
          docId,
          sex: result.meta.patient_sex,
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
      if (adopted.changed) revalidatePath("/settings");
      revalidatePath("/biomarkers");
      // Imported body metrics surface on Body Metrics and the dashboard.
      revalidatePath("/trends");
      revalidatePath("/");
      // Fire-and-forget AI supplement suggestions from new/changed biomarkers, so
      // extraction latency is unchanged (the doc is already marked 'done'). No-ops
      // when nothing relevant changed, ANTHROPIC_API_KEY is unset, or the
      // auto-suggestions toggle is off (Settings → AI).
      void autoSuggestFromBiomarkers(profileId, insertedIds)
        .then((n) => {
          if (n > 0) revalidatePath("/medicine");
        })
        .catch((err) => log.error("auto-suggest failed", { docId, err }));
    } catch (err) {
      log.error("post-import steps failed (document already imported)", {
        docId,
        filename,
        err,
      });
    }
    return "done";
  } catch (err) {
    log.error("import/runner crashed", { docId, filename, err });
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(`Extraction crashed: ${errMsg(err)}`, docId, profileId);
    // A crash mid-run is transient from the quota's view — refund (#135 item 3).
    if (charged) refundAiUsage(profileId, "extraction");
    return "failed";
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
// extraction in the background — see reprocessDocument.
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
  const claimed = db
    .prepare(
      "UPDATE medical_documents SET extraction_status = 'processing', extraction_error = NULL, processing_started_at = datetime('now') WHERE id = ? AND profile_id = ? AND extraction_status != 'processing'"
    )
    .run(docId, profileId);
  if (claimed.changes === 0) return { status: "processing" }; // already in flight
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
async function reprocessOne(
  profileId: number,
  docId: number
): Promise<"done" | "failed" | "skipped" | "missing" | "processing"> {
  const prep = beginReprocess(profileId, docId);
  if ("status" in prep) return prep.status;
  // A health record (CCD/XDM/SHC) re-imports deterministically — no AI, no key.
  if (detectHealthRecord(prep.buffer))
    return persistHealthRecordDoc(profileId, docId, prep.buffer).status;
  if (!aiConfigured()) {
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
        true
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

// Re-extraction may change canonical names — drop any now-orphaned stars.
function cleanupOrphanStars(profileId: number) {
  db.prepare(
    `DELETE FROM starred_biomarkers
     WHERE profile_id = ?
       AND canonical_name NOT IN (
         SELECT canonical_name FROM medical_records
          WHERE profile_id = ? AND canonical_name IS NOT NULL
       )`
  ).run(profileId, profileId);
}

function revalidateAfterReprocess() {
  revalidatePath("/data");
  revalidatePath("/import/[id]", "page");
  revalidatePath("/biomarkers");
  revalidatePath("/trends");
  revalidatePath("/immunizations");
  revalidatePath("/");
}

// Re-run AI extraction on every uploaded document and replace its imported
// records with the fresh results. This OVERWRITES any manual edits made to a
// document's records (manual standalone records are untouched). Runs the
// documents sequentially to stay within API rate limits.
export async function reprocessAllDocuments(): Promise<ReprocessResult> {
  const { login, profile } = await requireWriteAccess();
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
      .all(profile.id) as { id: number }[]
  ).map((r) => r.id);
  if (ids.length === 0) {
    return { status: "done", message: "No uploaded documents to reprocess." };
  }

  let done = 0;
  let failed = 0;
  let missing = 0;
  let skipped = 0;
  for (const id of ids) {
    const status = await withAiLogContext(
      { loginId: login.id, profileId: profile.id },
      () => reprocessOne(profile.id, id)
    );
    if (status === "done") done++;
    else if (status === "missing") missing++;
    else if (status === "skipped") skipped++;
    else if (status === "processing")
      continue; // claimed by a concurrent call
    else failed++;
  }

  cleanupOrphanStars(profile.id);
  revalidateAfterReprocess();

  const parts = [`Reprocessed ${done} document${done === 1 ? "" : "s"}`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (missing) parts.push(`${missing} missing file${missing === 1 ? "" : "s"}`);
  return { status: "done", message: parts.join(", ") + "." };
}

// Reprocess a single document (form action). Overwrites that document's records.
// Mirrors the upload path: flip the document to 'processing' and run extraction
// in the BACKGROUND (do NOT await) so the action returns immediately. Awaiting
// the AI call here would keep the client's transition pending for its entire
// duration, freezing the page. The app-wide ExtractionToaster poller refreshes
// the page and toasts once the background job finishes; the row shows a spinner
// (status 'processing') in the meantime.
export async function reprocessDocument(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const prep = beginReprocess(profile.id, id);
  if ("status" in prep) {
    // Nothing to run — missing file (status already recorded) or already claimed
    // by a concurrent reprocess. Just refresh to show the current status.
    revalidateAfterReprocess();
    return;
  }
  // A health record (CCD/XDM/SHC) re-imports deterministically — no AI, no key.
  // Small files run inline; large ones defer so the action returns immediately.
  if (detectHealthRecord(prep.buffer)) {
    runHealthImport(profile.id, id, prep.buffer, () => {
      cleanupOrphanStars(profile.id);
      revalidateAfterReprocess();
    });
    return;
  }
  if (!aiConfigured()) {
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(
      "AI not configured — set ANTHROPIC_API_KEY or AI_BASE_URL to reprocess.",
      id,
      profile.id
    );
    revalidateAfterReprocess();
    return;
  }
  // Daily AI cap: consume an extraction unit (key is present here). On exhaustion
  // the doc is marked 'skipped' with the limit message — refresh and return, don't
  // dispatch.
  if (!allowExtractionDispatch(profile.id, id)) {
    revalidateAfterReprocess();
    return;
  }
  // Fire-and-forget. runExtraction catches its own errors and marks the row, so
  // this never rejects; clean up orphaned stars and revalidate once it settles.
  // withAiLogContext carries the acting login/profile tags into the background
  // extraction via AsyncLocalStorage, and the concurrency limiter caps how many
  // extractions run at once. The trailing revalidate can reject when it fires
  // outside request scope — swallow it, the toaster poller refreshes anyway.
  void withAiLogContext({ loginId: login.id, profileId: profile.id }, () =>
    extractionSemaphore.run(() =>
      // charged=true — key present + cap allowed, so a transient failure refunds
      // the unit (#135 item 3).
      runExtraction(profile.id, id, prep.buffer, prep.mime, prep.filename, true)
    )
  )
    .then(() => {
      cleanupOrphanStars(profile.id);
      revalidateAfterReprocess();
    })
    .catch((err) => {
      // Shed the job if the limiter's queue is saturated (#135 item 2): mark
      // 'skipped' (reprocessable) and refund; otherwise log the unexpected reject.
      if (err instanceof QueueFullError) {
        db.prepare(
          "UPDATE medical_documents SET extraction_status = 'skipped', extraction_error = ? WHERE id = ? AND profile_id = ?"
        ).run(AI_QUEUE_FULL_DOC_MESSAGE, id, profile.id);
        refundAiUsage(profile.id, "extraction");
        revalidateAfterReprocess();
        return;
      }
      log.error("post-reprocess refresh failed", { id, err });
    });
  // Return now with the document marked 'processing' so the page swaps the
  // reprocess button for a spinner instead of blocking on the AI call.
  revalidateAfterReprocess();
}

// Re-extract a stored document to an in-memory PersistInput WITHOUT writing
// anything (reprocess-diff). This is the read-only twin of the
// reprocess writers: it reads the stored file and runs the same parse/extract the
// commit path would, but returns the shape instead of persisting it — so a diff
// preview can compare it against the currently-persisted rows and only the
// confirm step (reprocessDocument, unchanged) actually mutates the DB. Returns a
// `skip` reason when there's nothing to diff (no file, unsupported without a key,
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
        r.canonical = snapCanonicalName(
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
  if (!aiConfigured()) {
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
  const result = await extractMedicalDocument(
    buffer,
    d.mime_type || "application/octet-stream",
    d.filename,
    getCanonicalVocabulary()
  );
  if (result.status !== "done") {
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
  { status: "ok"; diff: ImportDiff } | { status: "skipped"; message: string };

// Preview what a reprocess would change: re-extract to an
// in-memory PersistInput, diff it against the currently-persisted rows, and return
// the diff WITHOUT touching the DB. The client shows the diff, then calls
// reprocessDocument (the unchanged commit path) to actually apply it. AI
// re-extraction is nondeterministic, so the preview is indicative — the confirmed
// reprocess re-extracts and may differ slightly; deterministic health records are
// exact.
export async function previewReprocess(
  formData: FormData
): Promise<PreviewReprocessResult> {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { status: "skipped", message: "Unknown document." };
  // Guard the id against another profile before reading its file.
  if (!getMedicalDocument(profile.id, id)) {
    return { status: "skipped", message: "Unknown document." };
  }
  const extracted = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => extractPersistInputForPreview(profile.id, id)
  );
  if ("skip" in extracted)
    return { status: "skipped", message: extracted.skip };
  const current = getReprocessSnapshot(profile.id, id);
  const next = snapshotFromPersistInput(extracted.input);
  return { status: "ok", diff: computeImportDiff(current, next) };
}

export interface ReassignResult {
  status: "done" | "error";
  message: string;
}

// Move a mis-filed document — the medical_documents row, every row it imported,
// and its on-disk file — to another profile the acting login can access.
// One transaction re-points profile_id on the document and each
// imported child row; the file is moved afterward best-effort (if the move fails
// the stored_path keeps pointing at the old, still-served location). Each UPDATE
// is scoped to the SOURCE profile + the document's provenance link, so it can
// never sweep another profile's rows — that source-scoped WHERE is also what keeps
// the profile-scoping guard green.
export async function reassignDocument(
  formData: FormData
): Promise<ReassignResult> {
  const session = await requireWriteAccess();
  const src = session.profile.id;
  const id = Number(formData.get("id"));
  const dest = Number(formData.get("destProfileId"));
  if (!id) return { status: "error", message: "Unknown document." };

  // The document must belong to the acting (source) profile.
  const doc = getMedicalDocument(src, id);
  if (!doc) return { status: "error", message: "Unknown document." };

  // Refuse to move a document whose extraction is still in flight. The background
  // runExtraction/persist writes its rows (and the 'done' finalize) against the
  // LITERAL source profile_id it was started with; re-pointing the document to B
  // mid-flight would land those rows orphaned under A while the finalize
  // (WHERE id=? AND profile_id=A) no-ops, stranding the doc 'processing' under B
  // with no content. Wait for it to settle first.
  if (doc.extraction_status === "processing") {
    return {
      status: "error",
      message:
        "This document is still processing — wait for it to finish, then move it.",
    };
  }

  // Pure gate: destination is a real, different, accessible profile.
  const accessibleProfileIds = (await getAccessibleProfiles()).map((p) => p.id);
  const decision = canReassignDocument({
    sourceProfileId: src,
    destProfileId: dest,
    accessibleProfileIds,
  });
  if (!decision.ok) return { status: "error", message: decision.reason };

  // Reassigning WRITES to the destination profile, so a write grant on the
  // source alone isn't enough — a member holding profile B read-only must not be
  // able to push documents into B from a writable A (issue #33). Admins resolve
  // to 'write' implicitly.
  if (
    accessForProfile(session.login.id, session.login.role, dest) !== "write"
  ) {
    return {
      status: "error",
      message: "You have view-only access to that profile.",
    };
  }

  const source = documentSource(id);
  // Re-point every owned row from the source profile to the destination, scoped to
  // this document's provenance (document_id for records/allergies/conditions/
  // encounters/extracted meds; documentSource(id) for body_metrics/immunizations/
  // height + head-circ metric_samples) AND to the source profile_id so no other
  // profile's rows can be touched. Child rows (intake_item_doses/_logs/_pairs,
  // medication_courses, side effects) carry no profile_id — they follow the parent
  // intake_items row. The on-disk file move + stored_path update happen after the
  // commit.
  const move = db.transaction(() => {
    db.prepare(
      "UPDATE medical_documents SET profile_id = ? WHERE id = ? AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE medical_records SET profile_id = ? WHERE document_id = ? AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE allergies SET profile_id = ? WHERE document_id = ? AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE conditions SET profile_id = ? WHERE document_id = ? AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE encounters SET profile_id = ? WHERE document_id = ? AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE intake_items SET profile_id = ? WHERE document_id = ? AND source = 'extracted' AND profile_id = ?"
    ).run(dest, id, src);
    db.prepare(
      "UPDATE body_metrics SET profile_id = ? WHERE source = ? AND profile_id = ?"
    ).run(dest, source, src);
    db.prepare(
      "UPDATE immunizations SET profile_id = ? WHERE source = ? AND profile_id = ?"
    ).run(dest, source, src);
    db.prepare(
      "UPDATE metric_samples SET profile_id = ? WHERE source = ? AND profile_id = ?"
    ).run(dest, source, src);
    // A star on the source profile may now point at a biomarker with no remaining
    // records there — drop any orphaned ones (mirrors deleteMedicalDocument).
    db.prepare(
      `DELETE FROM starred_biomarkers
        WHERE profile_id = ?
          AND canonical_name NOT IN (
            SELECT canonical_name FROM medical_records
             WHERE profile_id = ? AND canonical_name IS NOT NULL
          )`
    ).run(src, src);
  });
  move();

  // Re-derive out-of-range flags on the destination: reconciledFlag depends on the
  // profile's sex/birthdate/age/reproductive-status, so the moved medical_records
  // still carry flags computed against the SOURCE profile's demographics until this
  // runs. The source needs no re-reconcile — the moved rows are gone from it, and
  // its remaining rows' demographics didn't change.
  reconcileFlags(dest);

  // Move the stored file into the destination profile's upload directory. This is
  // best-effort and path-contained: source is the app-written stored_path, dest is
  // app-constructed under UPLOAD_DIR — both must resolve inside UPLOAD_DIR. If the
  // move fails, stored_path is left as-is (the file stays under the old profile
  // dir, still inside the root, so the id+profile-scoped serve route still finds it).
  if (doc.stored_path) {
    try {
      const root = path.resolve(UPLOAD_DIR);
      const fromAbs = path.resolve(process.cwd(), doc.stored_path);
      const destDir = path.join(UPLOAD_DIR, String(dest));
      const toAbs = path.resolve(destDir, path.basename(fromAbs));
      const contained = (p: string) =>
        p === root || p.startsWith(root + path.sep);
      if (contained(fromAbs) && contained(toAbs) && fromAbs !== toAbs) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(fromAbs, toAbs);
        const relPath = path.join(
          "data",
          "uploads",
          "medical",
          String(dest),
          path.basename(toAbs)
        );
        db.prepare(
          "UPDATE medical_documents SET stored_path = ? WHERE id = ? AND profile_id = ?"
        ).run(relPath, id, dest);
      }
    } catch (err) {
      log.error("reassign file move failed (rows already moved)", { id, err });
    }
  }

  revalidatePath("/import/[id]", "page");
  revalidatePath("/data");
  revalidatePath("/biomarkers");
  revalidatePath("/trends");
  revalidatePath("/immunizations");
  revalidatePath("/");
  return {
    status: "done",
    message: "Document moved.",
  };
}

export interface ExtractionState {
  id: number;
  filename: string;
  status: string;
  count: number;
  error: string | null;
}

// Lightweight status snapshot for the client toaster to poll. The table is
// small (one row per uploaded document), so returning all rows is cheap and
// lets the client detect status transitions (e.g. processing → done) and show
// the failure reason on error.
export async function getExtractionStates(): Promise<ExtractionState[]> {
  const { profile } = await requireSession();
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, extracted_count AS count,
              extraction_error AS error
       FROM medical_documents WHERE profile_id = ?`
    )
    .all(profile.id) as ExtractionState[];
}

export async function deleteMedicalDocument(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const doc = db
    .prepare(
      "SELECT stored_path FROM medical_documents WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as { stored_path: string } | undefined;
  if (doc)
    recordAudit({
      loginId: login.id,
      profileId: profile.id,
      action: AUDIT_ACTIONS.medicalDocDelete,
      target: String(id),
    });

  const removeAll = db.transaction(() => {
    // Delete every row this document imported — medical_records, extracted
    // medications, body_metrics, height + head-circumference metric_samples,
    // immunizations, allergies, conditions, and encounters. This is the SAME
    // shared helper the reprocess delete-set runs (lib/import-persist), so the
    // delete path can't leak rows the reprocess path clears (the drift that
    // orphaned head-circ/allergy/condition/encounter rows). It
    // also clears the auto-structured meds BEFORE the medical_documents row is
    // dropped, which their intake_items.document_id foreign key requires.
    clearImportedDocumentRows(profile.id, id);
    db.prepare(
      "DELETE FROM medical_documents WHERE id = ? AND profile_id = ?"
    ).run(id, profile.id);
    // Drop stars whose biomarker no longer has any remaining records, so the
    // pinned card stays clean.
    db.prepare(
      `DELETE FROM starred_biomarkers
       WHERE profile_id = ?
         AND canonical_name NOT IN (
           SELECT canonical_name FROM medical_records
            WHERE profile_id = ? AND canonical_name IS NOT NULL
         )`
    ).run(profile.id, profile.id);
  });
  removeAll();

  if (doc?.stored_path) {
    try {
      fs.rmSync(path.join(process.cwd(), doc.stored_path), { force: true });
    } catch {
      // best-effort; row is already gone
    }
  }
  revalidatePath("/data");
  revalidatePath("/biomarkers");
  revalidatePath("/trends");
  revalidatePath("/");
}

function insertFailedDoc(
  profileId: number,
  filename: string,
  mime: string,
  size: number,
  error: string
) {
  db.prepare(
    `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, extraction_status, extraction_error, profile_id)
     VALUES (?,?,?,?, 'failed', ?, ?)`
  ).run(filename, "", mime, size, error, profileId);
}

// Record a rejected duplicate upload as a 'skipped' row (no file stored) so the
// user is alerted in the documents list. We still persist content_hash so the
// row is self-describing, and name the original file it duplicates. When that
// original hasn't successfully imported (e.g. its extraction failed), point the
// user at reprocessing it rather than re-uploading.
function insertDuplicateDoc(
  profileId: number,
  filename: string,
  mime: string,
  size: number,
  contentHash: string,
  originalName: string,
  originalStatus: string
) {
  const target =
    filename === originalName
      ? "this file was already uploaded"
      : `identical contents to "${originalName}" (already uploaded)`;
  const advice =
    originalStatus === "done"
      ? "Skipped."
      : "Reprocess that document instead of re-uploading.";
  const error = `Duplicate upload — ${target}. ${advice}`;
  db.prepare(
    `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, content_hash, extraction_status, extraction_error, profile_id)
     VALUES (?,?,?,?,?, 'skipped', ?, ?)`
  ).run(filename, "", mime, size, contentHash, error, profileId);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
