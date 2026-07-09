"use server";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { resolveProviderIdByName } from "@/lib/providers-db";

// Visit / encounter writes (#178 Phase B). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/allergies), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns (source/document_id/external_id/class_code) intact. The
// attending clinician + facility are resolved through the shared GLOBAL providers
// registry via create-on-type names, same as the appointments/medical forms.

function revalidateEncounters() {
  revalidatePath("/encounters");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addEncounter(formData: FormData) {
  const { profile } = requireSession();
  const date = dateOrNull(formData.get("date"));
  if (!date) return; // the visit date is required (NOT NULL) and must be real
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
}

export async function updateEncounter(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  const date = dateOrNull(formData.get("date"));
  if (!id || !date) return;
  const endDate = dateOrNull(formData.get("end_date"));
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  const locationId = resolveProviderIdByName(
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
    profile.id
  );
  revalidateEncounters();
}

export async function deleteEncounter(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM encounters WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateEncounters();
}
