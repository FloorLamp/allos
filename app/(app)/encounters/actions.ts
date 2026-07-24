"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidatePath } from "next/cache";
import { db, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import { nullEncounterLinks } from "@/lib/queries";

// Visit / encounter writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/allergies), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns (source/document_id/external_id/class_code) intact. The
// attending clinician + facility are resolved through the shared GLOBAL providers
// registry via create-on-type names, same as the appointments/medical forms.

function revalidateEncounters() {
  revalidatePath("/records");
  revalidatePath("/profile");
  revalidatePath("/");
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

export async function deleteEncounter(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that visit.");
  writeTx(() => {
    // Row-ops side-state (#288): an appointment may link this visit
    // (appointments.encounter_id). encounters carries no ON DELETE action, so NULL
    // the back-link FIRST — the appointment (and its completed status) is
    // preserved, just unlinked — otherwise the FK would block the delete.
    db.prepare(
      "UPDATE appointments SET encounter_id = NULL WHERE encounter_id = ? AND profile_id = ?"
    ).run(id, profileId);
    // Row-ops side-state (#1050/#1053): NULL every record/med/condition/procedure/
    // imaging/immunization/episode back-link to this visit before deleting it — those
    // encounter_id FKs carry no ON DELETE, so the FK would otherwise block the delete.
    nullEncounterLinks(profileId, id);
    db.prepare("DELETE FROM encounters WHERE id = ? AND profile_id = ?").run(
      id,
      profileId
    );
  });
  revalidateEncounters();
  return formOk();
}
