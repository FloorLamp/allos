"use server";
// Medical RECORD CRUD server actions (issue #318). The document upload/extract/
// reprocess/reassign/delete PIPELINE lives in the sibling document-actions.ts (two
// "use server" files coexist per route) — split apart so the pipeline's churn no
// longer collides with the humble record form. This file holds only the manual
// biomarker-record write path: addRecord / updateRecord / deleteRecord.
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import { isRealIsoDate } from "@/lib/date";
import {
  MEDICAL_CATEGORIES,
  BIOMARKER_CATEGORIES,
  MEDICAL_FLAGS,
} from "@/lib/medical-categories";
import {
  reconcileFlags,
  cleanupOrphanBiomarkerKeyedState,
  migrateRenamedBiomarker,
} from "@/lib/queries";
import { resolveProviderIdByName } from "@/lib/providers-db";
import { formError, formOk, type FormResult } from "@/lib/types";

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

export async function addRecord(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  // Validate the category server-side, exactly as updateRecord does — an absent
  // field (String(null) === "null") or a crafted/stale POST would otherwise flow
  // straight into the CHECK (category IN (...)) and 500 (#385, the #323 class:
  // a state writable in TS but forbidden by the CHECK). The add form only offers
  // BIOMARKER_CATEGORIES (no 'prescription' — meds live on the document view /
  // Supplements & Meds), so enforce that same set here and fall back to 'lab',
  // closing the client-only prescription gate the page's option list can't.
  const categoryRaw = String(formData.get("category") ?? "");
  const category = (BIOMARKER_CATEGORIES as readonly string[]).includes(
    categoryRaw
  )
    ? categoryRaw
    : "lab";
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date)) return formError("Enter a valid date.");
  if (!name) return formError("Enter a name.");
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
  return formOk();
}

// Edit a single extracted/manual record (used on the document subpage).
export async function updateRecord(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that record.");
  const date = String(formData.get("date") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date)) return formError("Enter a valid date.");
  if (!name) return formError("Enter a name.");

  const str = (k: string) => {
    const v = (formData.get(k) as string | null)?.trim();
    return v ? v : null;
  };
  const categoryRaw = String(formData.get("category") ?? "");
  const category = (MEDICAL_CATEGORIES as readonly string[]).includes(
    categoryRaw
  )
    ? categoryRaw
    : "lab";
  const flagRaw = str("flag");
  const flag =
    flagRaw && (MEDICAL_FLAGS as readonly string[]).includes(flagRaw)
      ? flagRaw
      : null;
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

  // Read the reading's PRIOR canonical grouping before overwriting it, so a
  // canonical rename can carry its star + retest dismissal to the new name rather
  // than orphaning them under the old (issue #203). The effective group name
  // mirrors the retest nudge / star derivation: canonical_name, falling back to
  // the raw name.
  const prev = db
    .prepare(
      "SELECT canonical_name, name FROM medical_records WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as
    { canonical_name: string | null; name: string } | undefined;
  const oldCanonical = prev ? prev.canonical_name?.trim() || prev.name : null;

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
  // A canonical rename re-keys this reading's group: migrate any star + retest
  // dismissal to the new name (the delete path already sweeps stars — the edit
  // path didn't), then sweep whatever the rename orphaned (a name-collision under
  // the new name leaves the old row for the sweep to drop). Guarded on an actual
  // name change so a plain value/date edit stays a no-op.
  if (oldCanonical && oldCanonical.toLowerCase() !== canonical.toLowerCase()) {
    migrateRenamedBiomarker(profile.id, oldCanonical, canonical);
    cleanupOrphanBiomarkerKeyedState(profile.id);
  }
  revalidateMedical();
  return formOk();
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
  // pointing at nothing (an empty pinned tile), and its `biomarker:<name>` retest
  // snooze pointing at a gone reading — sweep BOTH name-keyed side-stores so
  // re-adding that marker later re-nudges/re-pins instead of being silenced by a
  // stale row (issues #203/#327).
  // NOTE (consciously scoped out of undo): a star/dismissal orphan-cleaned here is
  // NOT re-created on Undo — the reading returns but the pinned-tile star stays gone.
  cleanupOrphanBiomarkerKeyedState(profile.id);
  revalidateMedical();
  return { undoId };
}
