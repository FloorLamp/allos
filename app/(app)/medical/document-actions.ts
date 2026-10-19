"use server";
import {
  accessForProfile,
  getAccessibleProfiles,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import { reassignDocumentCore } from "@/lib/document-reassign";
import { gateItemProfile } from "../gate-item";

import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { db, writeTx } from "@/lib/db";
import { writeDocumentTombstone } from "@/lib/document-tombstones";
import {
  clearImportedDocumentRows,
  documentImmunizationVaccines,
} from "@/lib/import-persist";
import {
  computeReprocessAllCost,
  ingestMedicalUpload,
  previewReprocessById,
  reprocessAllForProfile,
  reprocessDocumentById,
  reprocessFromRawById,
  type PreviewReprocessResult,
  type ReprocessApplyOutcome,
  type ReprocessFromRawResult,
  type ReprocessResult,
} from "@/lib/medical-pipeline";
import {
  dryRunMedicalUpload,
  type DryRunReport,
} from "@/lib/medical-pipeline/dry-run";
import {
  cleanupOrphanBiomarkerKeyedState,
  sweepImmunizationDismissals,
} from "@/lib/queries";
import type { ReprocessCost } from "@/lib/reprocess-cost";
import { evictPreviewsForDocument } from "@/lib/reprocess-preview-cache";
import { revalidateRoute } from "@/lib/revalidate";
import { MEDICAL_UPLOAD_BATCH_CAP } from "@/lib/upload-gate";
import fs from "node:fs";
import path from "node:path";

// NOTE: no type re-exports from this module. Next 16's "use server" transform
// registers EVERY export name as a server reference before type erasure, so even
// an `export type { ... }` here becomes a dangling runtime reference in the
// production build (ReferenceError: ReprocessResult is not defined). Client
// components import these result types from @/lib/medical-pipeline directly.

// Outcome of an upload submit, returned to the form so it can tone the toast
// (single vs batch) and surface the soft-cap overflow note (issue #1008).
export interface UploadMedicalResult {
  // How many files were actually handed to the ingest engine (<= the soft cap).
  // Each becomes its own document row — a success at 'processing', or a failed-doc
  // row for an oversized/unsupported/mislabeled file — so per-file outcomes land
  // with no special batch handling.
  ingested: number;
  // Files beyond the soft cap that were NOT ingested this submit; the form asks the
  // user to add them in another batch. 0 for an ordinary within-cap upload.
  overflow: number;
  // How many of these files cleared a content-hash TOMBSTONE (#1777) — bytes the user
  // had previously deleted and has now put back by hand. A human upload IS the un-delete
  // intent, so the tombstone is cleared and the document becomes re-acquirable again;
  // the form says so, because silently un-blocking would make the Data → Review blocked
  // list appear to lose entries for no reason. 0 on an ordinary upload.
  restored: number;
}

// Upload one or more medical documents and store each on disk, then kick off AI
// extraction per file in the background. The action returns as soon as the files
// are saved (each at status 'processing'), so every document appears immediately;
// the page polls until extraction finishes and imports its results.
//
// Multi-file (issue #1008): the form submits every selected file under the same
// "file" key, so we read them with getAll and ingest them SEQUENTIALLY — awaiting
// each ingestMedicalUpload so we never buffer N large file bodies into memory at
// once (ingestMedicalUpload reads the whole file into a Buffer). A ~20-file soft
// cap protects the extraction queue: the first N are ingested and any remainder is
// reported back for another batch, rather than a hard wall that rejects the submit.
export async function uploadMedicalDocument(
  formData: FormData
): Promise<UploadMedicalResult> {
  // #4932: the quick-log sheet's subject chip mounts this SAME form cross-profile,
  // so the write follows `gateItemProfile` like every other sheet body — posted
  // `profile_id` → requireProfileWriteAccess, absent → acting profile. `login` is
  // resolved separately (it stamps who ingested the file, not who it is for).
  const { login } = await requireSession();
  const profileId = await gateItemProfile(formData);
  // A multi-file submit holds several values under the one "file" key; keep only
  // real, non-empty Files (an empty file input can yield a zero-byte File).
  const files = formData
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ingested: 0, overflow: 0, restored: 0 };

  // Soft cap: ingest the first N, leave the remainder for another batch.
  const toIngest = files.slice(0, MEDICAL_UPLOAD_BATCH_CAP);
  const overflow = files.length - toIngest.length;

  // Sequential on purpose — awaiting each keeps at most one file body buffered at a
  // time. A per-file reject (too large / unsupported / mislabeled) inserts its own
  // failed-doc row inside ingestMedicalUpload and the loop keeps going, so a mixed
  // batch lands per-file outcomes with no special handling here.
  let restored = 0;
  for (const file of toIngest) {
    const out = await ingestMedicalUpload(login.id, profileId, file);
    if (out.restored) restored++;
  }
  // ingestMedicalUpload already revalidates /data per file; one revalidate after the
  // whole batch keeps the Review feed fresh once everything has landed.
  revalidateRoute("/data");
  return { ingested: toIngest.length, overflow, restored };
}

// "Check first": what uploading these files would do, per file, writing nothing
// (lib/medical-pipeline/dry-run.ts). Same gate and batch cap as the upload above.
export async function checkMedicalDocuments(
  formData: FormData
): Promise<DryRunReport[]> {
  const profileId = await gateItemProfile(formData);
  const readable = (await getAccessibleProfiles()).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const target = {
    id: profileId,
    name: readable.find((p) => p.id === profileId)?.name ?? "",
    decidedBy:
      Number(formData.get("profile_id")) > 0
        ? "the person picked in the form"
        : "the profile you're viewing",
  };
  const files = formData
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, MEDICAL_UPLOAD_BATCH_CAP);
  const reports: DryRunReport[] = [];
  for (const file of files) {
    reports.push(await dryRunMedicalUpload(target, file, readable));
  }
  return reports;
}

// Preview the cost of "Re-extract all documents" BEFORE running it (issue #208).
// Read-only.
export async function previewReprocessAllCost(): Promise<ReprocessCost> {
  const { profile } = await requireWriteAccess();
  return computeReprocessAllCost(profile.id);
}

// Re-run AI extraction on every uploaded document and replace its imported
// records with the fresh results. Runs the documents sequentially to stay within
// API rate limits.
export async function reprocessAllDocuments(): Promise<ReprocessResult> {
  const { login, profile } = await requireWriteAccess();
  return reprocessAllForProfile(login.id, profile.id);
}

// Re-apply a document's SAVED extraction — no AI call, no quota (#903). With no
// model call there's nothing slow to background, so the caller gets the real
// outcome straight back (contrast the preview-first re-extraction path below).
export async function reprocessDocumentFromRaw(
  formData: FormData
): Promise<ReprocessFromRawResult> {
  const { login, writeProfileId } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { status: "skipped", message: "Unknown document." };
  return reprocessFromRawById(login.id, writeProfileId, id);
}

// Preview what a reprocess would change: re-extract to an in-memory shape, diff it
// against the currently-persisted rows, and return the diff WITHOUT touching the
// DB. The client shows the diff, then calls applyReprocessPreview to apply it. The
// result carries a single-use `previewToken` (#946) that lets the apply commit THIS
// exact input.
export async function previewReprocess(
  formData: FormData
): Promise<PreviewReprocessResult> {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { status: "skipped", message: "Unknown document." };
  return previewReprocessById(login.id, profile.id, id);
}

// Missing preview input is a refusal. Fresh extraction requires explicit intent.
export async function applyReprocessPreview(
  formData: FormData
): Promise<ReprocessApplyOutcome> {
  const { login, writeProfileId } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0)
    return { mode: "refused", error: "Couldn't find this document." };
  const token = formData.get("previewToken");
  if (typeof token === "string" && token)
    return reprocessDocumentById(login.id, writeProfileId, id, token);
  if (formData.get("force") === "true")
    return reprocessDocumentById(login.id, writeProfileId, id);
  return {
    mode: "refused",
    error: "Preview changes again before saving.",
  };
}

export interface ReassignResult {
  status: "done" | "error";
  message: string;
}

export async function reassignDocument(
  formData: FormData
): Promise<ReassignResult> {
  const session = await requireWriteAccess();
  const dest = Number(formData.get("destProfileId"));
  const ids = (await getAccessibleProfiles()).map((p) => p.id);
  if (
    !ids.includes(dest) ||
    accessForProfile(session.login.id, session.login.role, dest) !== "write"
  )
    return {
      status: "error",
      message: "You have view-only access to that profile.",
    };
  return reassignDocumentCore(
    session.profile.id,
    session.login.id,
    ids,
    formData
  );
}

// The client toaster's status snapshot USED to live here as a read action, with
// its `ExtractionState` shape. Both moved with the poll itself (#1878): the read
// is now the route handler app/api/jobs/extractions and the shape is a WIRE type
// in lib/toaster-poll.ts, owned by the module that parses it. A Server Action's
// response carries a freshly rendered page tree that Next applies, so polling one
// repainted the page under a half-typed record form outside the dirty-form
// registry.

export async function deleteMedicalDocument(formData: FormData) {
  const { login, profile, writeProfileId } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  // content_hash + filename come back too: they are the TOMBSTONE (#1777), and this read
  // is the last moment allos still knows either — the row is dropped below.
  const doc = db
    .prepare(
      `SELECT stored_path, content_hash, filename
         FROM medical_documents WHERE id = ? AND profile_id = ?`
    )
    .get(id, profile.id) as
    | { stored_path: string; content_hash: string | null; filename: string }
    | undefined;
  if (doc)
    recordAudit({
      loginId: login.id,
      profileId: profile.id,
      action: AUDIT_ACTIONS.medicalDocDelete,
      target: String(id),
    });

  // NO 'processing' guard here, and that is SAFE BY ACCIDENT (issue #469): if a
  // reprocess is mid-flight when this runs, dropping the medical_documents row would
  // orphan the in-flight extraction's writes — but every footprint table carries a
  // document_id FK REFERENCES medical_documents(id), so the racing persist's INSERTs
  // hit the missing parent and roll back WHOLE. Nothing is half-imported. This is
  // load-bearing: if those FKs are ever loosened, delete-during-extraction becomes a
  // silent partial import and this path must grow its own atomic 'processing' claim
  // (the pattern reassignDocument uses). A DB-tier test pins the rollback so a
  // refactor can't quietly remove the FKs this relies on.
  writeTx(() => {
    // Capture the vaccine codes this document backs BEFORE the clear — afterward its
    // immunization rows are gone, so we can't tell which codes lost their backing (#602).
    const removedVaccines = documentImmunizationVaccines(profile.id, id);
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
    // REMEMBER THE DELETION (#1777). Without this the content hash leaves no trace, so
    // an acquirer re-offering the same bytes tomorrow is indistinguishable from a first
    // offer and the document silently comes back — the resurrection #1776's inventory
    // endpoint would otherwise invite. Written INSIDE this transaction so the row's
    // disappearance and the memory of it are one atomic fact.
    //
    // Written for EVERY delete, not only a portal-acquired one: the hash is the
    // identity, and a person who deletes a document has said so about the bytes,
    // whichever path first brought them in. Provenance changes only what the confirm
    // dialog SAYS (a manually uploaded document has no acquirer to block today), never
    // whether the deletion is remembered.
    //
    // A row with no content_hash predates hashing or is a 'failed' marker that never
    // got bytes; there is nothing for an acquirer to match, so there is nothing to
    // block.
    if (doc?.content_hash) {
      writeDocumentTombstone(writeProfileId, doc.content_hash, doc.filename);
    }
    // Drop stars AND retest/flag dismissals whose biomarker no longer has any
    // remaining records, so a later document reintroducing that name re-pins/
    // re-nudges instead of inheriting the stale, name-keyed side-state (#327).
    cleanupOrphanBiomarkerKeyedState(profile.id);
    // Sweep the `immunization:<code>` due-nudge dismissal of any vaccine this document
    // just un-backed, so a later re-add re-surfaces the nudge instead of hitting a
    // stale suppression — the #376 sweep the per-dose delete does, extended to the
    // document delete path (#602). No-op when the deleted doses still have siblings.
    sweepImmunizationDismissals(profile.id, removedVaccines);
  });

  // The document is gone — drop any cached reprocess-preview input for it (#946).
  evictPreviewsForDocument(profile.id, id);

  if (doc?.stored_path) {
    try {
      fs.rmSync(
        path.join(/* turbopackIgnore: true */ process.cwd(), doc.stored_path),
        { force: true }
      );
    } catch {
      // best-effort; row is already gone
    }
  }
  revalidateRoute("/data");
  revalidateRoute("/results");
  revalidateRoute("/trends");
  // A deleted document can drop immunization rows — refresh the passport view too
  // (reassignDocument already does; this closes the gap #602 noted).
  revalidateRoute("/records");
  revalidateRoute("/");
}
