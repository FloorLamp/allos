"use server";
// Medical document PIPELINE server actions (issue #318). Split out of the sibling
// actions.ts (which keeps record CRUD — addRecord/updateRecord/deleteRecord) so the
// document upload/extract/reprocess/reassign/delete surface no longer churns the
// same file as the humble record form. These are thin auth-and-revalidate wrappers:
// the pipeline engine (ingest, extraction, reprocess core, preview) lives in
// lib/medical-pipeline.ts, where the DB test tier can reach it. Two "use server"
// files coexist per route, so callers import each action from whichever file owns it.
import {
  requireSession,
  requireWriteAccess,
  getAccessibleProfiles,
  accessForProfile,
} from "@/lib/auth";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  reconcileFlags,
  getMedicalDocument,
  cleanupOrphanBiomarkerKeyedState,
} from "@/lib/queries";
import {
  clearImportedDocumentRows,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { canReassignDocument } from "@/lib/import-reassign";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";
import {
  ingestMedicalUpload,
  reprocessAllForProfile,
  reprocessDocumentById,
  previewReprocessById,
  computeReprocessAllCost,
  UPLOAD_DIR,
  type ReprocessResult,
  type PreviewReprocessResult,
} from "@/lib/medical-pipeline";
import type { ReprocessCost } from "@/lib/reprocess-cost";

// NOTE: no type re-exports from this module. Next 16's "use server" transform
// registers EVERY export name as a server reference before type erasure, so even
// an `export type { ... }` here becomes a dangling runtime reference in the
// production build (ReferenceError: ReprocessResult is not defined). Client
// components import these result types from @/lib/medical-pipeline directly.

const log = createLogger("medical");

// Upload a medical document and store it on disk, then kick off AI extraction
// in the background. The action returns as soon as the file is saved (status
// 'processing'), so the document appears immediately; the page polls until
// extraction finishes and imports its results.
export async function uploadMedicalDocument(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  await ingestMedicalUpload(login.id, profile.id, file);
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

// Reprocess a single document (form action). Overwrites that document's records.
// Runs extraction in the BACKGROUND so the action returns immediately.
export async function reprocessDocument(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  reprocessDocumentById(login.id, profile.id, id);
}

// Preview what a reprocess would change: re-extract to an in-memory shape, diff it
// against the currently-persisted rows, and return the diff WITHOUT touching the
// DB. The client shows the diff, then calls reprocessDocument to apply it.
export async function previewReprocess(
  formData: FormData
): Promise<PreviewReprocessResult> {
  const { login, profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { status: "skipped", message: "Unknown document." };
  return previewReprocessById(login.id, profile.id, id);
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
  // with no content. Wait for it to settle first. This is a fast-path bail on the
  // status we just read — but the read is NOT relied on for correctness: the move
  // transaction below re-checks the status atomically as its claim (issue #469),
  // since a concurrent reprocess could flip the row to 'processing' in the await
  // window between here and the move.
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

  // Re-point the document row + its ENTIRE per-row footprint from the source
  // profile to the destination. The footprint move goes through the shared
  // moveImportedDocumentRows helper (driven off the ONE IMPORT_FOOTPRINT_TABLES
  // list that clearImportedDocumentRows also consumes), so a reassign and a
  // delete/reprocess can never disagree about which tables a document owns — the
  // drift that stranded procedures/family_history/care_plan_items/care_goals
  // cross-profile with an FK-500 on the new owner's later delete (#201). Every
  // statement is scoped to the source profile_id so no other profile's rows can be
  // touched; the on-disk file move + stored_path update happen after the commit.
  //
  // ATOMIC CLAIM (issue #469): the re-point IS the guard. The status re-check lives
  // inside the same UPDATE — `AND extraction_status NOT IN ('processing','pending')`
  // — so a concurrent reprocess that claimed the row 'done'->'processing' in the
  // await window above makes this UPDATE match 0 rows. On a 0-change claim we abort
  // the whole move (leaving the footprint under the source, where the still-in-flight
  // persist/finalize correctly lands its rows) and report it as still-processing.
  // Without this the read-then-move raced: the in-flight persist would insert a
  // SECOND full record set under the source pointing at a document now owned by dest,
  // recreating the #201 cross-profile stranding through a race.
  let claimed = false;
  const move = db.transaction(() => {
    const res = db
      .prepare(
        "UPDATE medical_documents SET profile_id = ? WHERE id = ? AND profile_id = ? AND extraction_status NOT IN ('processing','pending')"
      )
      .run(dest, id, src);
    if (res.changes !== 1) return; // lost the claim — leave everything untouched
    claimed = true;
    moveImportedDocumentRows(src, dest, id);
    // A star OR a retest/flag dismissal on the SOURCE profile may now point at a
    // biomarker with no remaining records there — sweep both name-keyed side-stores
    // (#327). Only the source can orphan: the destination only GAINS records here,
    // so no dest pin/snooze can lose its backing. (mirrors deleteMedicalDocument.)
    cleanupOrphanBiomarkerKeyedState(src);
  });
  move();
  if (!claimed) {
    return {
      status: "error",
      message:
        "This document is still processing — wait for it to finish, then move it.",
    };
  }

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

  // NO 'processing' guard here, and that is SAFE BY ACCIDENT (issue #469): if a
  // reprocess is mid-flight when this runs, dropping the medical_documents row would
  // orphan the in-flight extraction's writes — but every footprint table carries a
  // document_id FK REFERENCES medical_documents(id), so the racing persist's INSERTs
  // hit the missing parent and roll back WHOLE. Nothing is half-imported. This is
  // load-bearing: if those FKs are ever loosened, delete-during-extraction becomes a
  // silent partial import and this path must grow its own atomic 'processing' claim
  // (the pattern reassignDocument uses). A DB-tier test pins the rollback so a
  // refactor can't quietly remove the FKs this relies on.
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
    // Drop stars AND retest/flag dismissals whose biomarker no longer has any
    // remaining records, so a later document reintroducing that name re-pins/
    // re-nudges instead of inheriting the stale, name-keyed side-state (#327).
    cleanupOrphanBiomarkerKeyedState(profile.id);
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
