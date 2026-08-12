"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidateRoute } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import { captureDelete } from "@/lib/undo-delete-db";

// Visit / encounter writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/allergies), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns (source/document_id/external_id/class_code) intact. The
// attending clinician + facility are resolved through the shared GLOBAL providers
// registry via create-on-type names, same as the appointments/medical forms.

function revalidateEncounters() {
  revalidateRoute("/records");
  revalidateRoute("/profile");
  revalidateRoute("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addEncounter(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = dateOrNull(formData.get("date"));
  // the visit date is required (NOT NULL) and must be real
  if (!date) return formError("Pick a date for this visit.");
  const endDate = dateOrNull(formData.get("end_date"));
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  const locationId = resolveProviderIdByName(
    String(formData.get("location") ?? "")
  );
  db.prepare(
    `INSERT INTO encounters
       (profile_id, date, end_date, type, reason, diagnoses,
        provider_id, location_provider_id, notes, source)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`
  ).run(
    profile.id,
    date,
    endDate,
    str(formData, "type"),
    str(formData, "reason"),
    str(formData, "diagnoses"),
    providerId,
    locationId,
    str(formData, "notes")
  );
  revalidateEncounters();
  return formOk();
}

export async function updateEncounter(formData: FormData): Promise<FormResult> {
  // Multi-view (#1359): gate + target the ROW's own profile (gateItemProfile), so an
  // edit on a non-acting member's visit lands on that member; single-view falls back
  // to the acting profile.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const date = dateOrNull(formData.get("date"));
  if (!id) return formError("Couldn't find that visit.");
  if (!date) return formError("Pick a date for this visit.");
  const endDate = dateOrNull(formData.get("end_date"));
  // Keep each loaded link unless its field was actually changed (#601) — an edit to
  // an unrelated field must not relink an ambiguously-named provider/facility.
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? "")
  );
  const locationId = resolveProviderOnEdit(
    Number(formData.get("location_provider_id")) || null,
    String(formData.get("location_loaded") ?? ""),
    String(formData.get("location") ?? "")
  );
  db.prepare(
    `UPDATE encounters
       SET date = ?, end_date = ?, type = ?, reason = ?, diagnoses = ?,
           provider_id = ?, location_provider_id = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    date,
    endDate,
    str(formData, "type"),
    str(formData, "reason"),
    str(formData, "diagnoses"),
    providerId,
    locationId,
    str(formData, "notes"),
    id,
    profileId
  );
  revalidateEncounters();
  return formOk();
}

// Delete a visit — CAPTURED, so it is restorable from the toast for the trash window
// (#1847). The row-ops side-state this used to do inline (the appointment back-link
// #288, and every record/med/condition/procedure/imaging/immunization/episode
// `encounter_id` #1050/#1053) moved INTO captureDelete beside the sibling clinical
// null-outs, so the Data → Manage bulk delete inherits it too — before that, bulk
// -deleting a linked visit threw on the FK. Those detaches are deliberately NOT
// restored: the visit comes back, the other rows' "recorded at" links stay honestly
// cleared, because a link is a statement about the OTHER row.
//
// Answers in the useUndoableDelete contract (the sibling clinical deletes' shape), not
// FormResult: the token IS the answer here, and a null one with an error is how "there
// was no such visit" is said.
export async function deleteEncounter(
  formData: FormData
): Promise<{ undoId: number | null; error?: string }> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null, error: "Couldn't find that visit." };
  const undoId = captureDelete("visit", profileId, id);
  if (undoId == null)
    return { undoId: null, error: "Couldn't find that visit." };
  revalidateEncounters();
  return { undoId };
}
