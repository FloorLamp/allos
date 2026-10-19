import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { db, writeTx } from "@/lib/db";
import { clearDocumentTombstone } from "@/lib/document-tombstones";
import {
  documentImmunizationVaccines,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { canReassignDocument } from "@/lib/import-reassign";
import { createLogger } from "@/lib/log";
import { UPLOAD_DIR } from "@/lib/medical-pipeline";
import {
  cleanupOrphanBiomarkerKeyedState,
  getMedicalDocument,
  reconcileFlags,
  sweepImmunizationDismissals,
} from "@/lib/queries";
import { evictPreviewsForDocument } from "@/lib/reprocess-preview-cache";
import { revalidateRoute } from "@/lib/revalidate";
import fs from "node:fs";
import path from "node:path";

const log = createLogger("medical");
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
export function reassignDocumentCore(
  src: number,
  loginId: number,
  accessibleProfileIds: number[],
  formData: FormData
): ReassignResult {
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
  //
  // ACQUIRED-BY PROVENANCE RIDES ALONG UNCHANGED (#1748). The UPDATE deliberately
  // re-points profile_id ONLY: `acquired_portal_id` records how the document ARRIVED —
  // it came off Ochsner's portal whoever it turns out to belong to — and that is a fact
  // about its arrival, not a claim about its owner. Clearing it on reassignment would
  // destroy exactly the audit trail the column exists for, and the single most likely
  // reason to reassign a portal document is that the binding sent it to the wrong
  // person: that is precisely when "which portal pushed this?" is the question being
  // asked. `patient_name` (the label the document itself carries) is likewise untouched,
  // and the mismatch notice already reads off it.
  let claimed = false;
  writeTx(() => {
    const res = db
      .prepare(
        "UPDATE medical_documents SET profile_id = ? WHERE id = ? AND profile_id = ? AND extraction_status NOT IN ('processing','pending')"
      )
      .run(dest, id, src);
    if (res.changes !== 1) return; // lost the claim — leave everything untouched
    claimed = true;
    // Capture the vaccine codes this document backs on the SOURCE BEFORE the move —
    // afterward its immunization rows live under the destination, so the source may
    // have lost the last backing for those codes (#602).
    const movedVaccines = documentImmunizationVaccines(src, id);
    moveImportedDocumentRows(src, dest, id);
    // Sweep any `immunization:<code>` due-nudge dismissal on the SOURCE whose backing
    // just moved away, so re-adding that immunization on the source re-surfaces the
    // nudge instead of hitting a stale suppression (#602/#203). Only the source can
    // orphan here (the destination only GAINS rows). Mirrors the biomarker sweep below.
    sweepImmunizationDismissals(src, movedVaccines);
    // A star OR a retest/flag dismissal on the SOURCE profile may now point at a
    // biomarker with no remaining records there — sweep both name-keyed side-stores
    // (#327). Only the source can orphan: the destination only GAINS records here,
    // so no dest pin/snooze can lose its backing. (mirrors deleteMedicalDocument.)
    cleanupOrphanBiomarkerKeyedState(src);
    // The DESTINATION now genuinely holds these bytes, so a stale content-hash
    // tombstone there is a lie (#1777): it would let #1776's inventory answer `held`
    // and `deleted` for the same hash, and would block an acquirer from re-offering a
    // document the destination demonstrably has. Clearing it keeps the two lists
    // disjoint by construction.
    //
    // The SOURCE deliberately gets NO tombstone. A reassignment is a correction of
    // FILING, not a deletion of content — the bytes are still in the household, the
    // user was told "Document moved.", and writing a blocking tombstone off the back of
    // that would be a silent policy write on a path that never mentioned one.
    if (doc.content_hash) clearDocumentTombstone(dest, doc.content_hash);
  });
  if (!claimed) {
    return {
      status: "error",
      message:
        "This document is still processing — wait for it to finish, then move it.",
    };
  }

  // The document changed owner — a preview token minted for the source profile is
  // now useless; drop it (#946). A token is profile-scoped anyway, so it could
  // never apply under the destination, but evicting keeps the cache tidy.
  evictPreviewsForDocument(src, id);

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
      const fromAbs = path.resolve(
        /* turbopackIgnore: true */ process.cwd(),
        doc.stored_path
      );
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

  // Audit the cross-profile move (issue #655): a document + its whole import
  // footprint just crossed profiles — the app's most audit-worthy data movement.
  // Identifiers only: the document id and the source→destination profile ids.
  recordAudit({
    loginId: loginId,
    profileId: src,
    action: AUDIT_ACTIONS.medicalDocReassign,
    target: String(id),
    detail: `profile ${src} → ${dest}`,
  });

  revalidateRoute("/import/[id]", "page");
  revalidateRoute("/data");
  revalidateRoute("/results");
  revalidateRoute("/trends");
  revalidateRoute("/records");
  revalidateRoute("/");
  return {
    status: "done",
    message: "Document moved.",
  };
}
