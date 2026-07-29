"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  normalizeDentalStatus,
  normalizeToothSystem,
  normalizeTooth,
  normalizeSurface,
} from "@/lib/dental";
import {
  trackDentalFollowUpCore,
  unlinkFollowUpsForDentalProcedure,
} from "@/lib/followup-write";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";

// Dental-procedure writes (#705). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/procedures), so the
// per-document import delete-set never touches them. status / tooth_system are
// normalized onto the DB CHECK sets through the ONE shared coercion in lib/dental
// (the same one the import path uses), so a form value that isn't a valid enum can
// never trip the CHECK — it degrades to the safe default ('completed' / null).
//
// Periodontal MEASUREMENTS are NOT written here — they are biomarker readings
// (medical_records) captured on the Biomarkers surface, the #698 vision-analyte
// precedent. This form captures the tooth-anchored procedure/finding narrative.

function revalidateDental() {
  // Dental folded into Health record (#1042 final tail): the surface is now
  // /records#dental.
  revalidatePath("/records");
  revalidatePath("/timeline");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

function intOrNull(raw: unknown): number | null {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export async function addDentalProcedure(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = str(formData, "name");
  if (!name) return formError("Enter a procedure or finding name.");
  // The performing/recording dentist, resolved through the shared GLOBAL registry
  // via a create-on-type name (#1088). NULL for a self-entered record.
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? ""),
    "individual"
  );
  db.prepare(
    `INSERT INTO dental_procedures
       (name, status, tooth, tooth_system, surface, cdt_code, procedure_date,
        finding, follow_up_interval_days, notes, provider_id, source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    name,
    normalizeDentalStatus(formData.get("status")),
    normalizeTooth(formData.get("tooth")),
    normalizeToothSystem(formData.get("tooth_system")),
    normalizeSurface(formData.get("surface")),
    str(formData, "cdt_code"),
    dateOrNull(formData.get("procedure_date")),
    str(formData, "finding"),
    intOrNull(formData.get("follow_up_interval_days")),
    str(formData, "notes"),
    providerId,
    profile.id
  );
  revalidateDental();
  return formOk();
}

export async function updateDentalProcedure(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that record.");
  const name = str(formData, "name");
  if (!name) return formError("Enter a procedure or finding name.");
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? ""),
    "individual"
  );
  db.prepare(
    `UPDATE dental_procedures
       SET name = ?, status = ?, tooth = ?, tooth_system = ?, surface = ?,
           cdt_code = ?, procedure_date = ?, finding = ?,
           follow_up_interval_days = ?, notes = ?, provider_id = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    name,
    normalizeDentalStatus(formData.get("status")),
    normalizeTooth(formData.get("tooth")),
    normalizeToothSystem(formData.get("tooth_system")),
    normalizeSurface(formData.get("surface")),
    str(formData, "cdt_code"),
    dateOrNull(formData.get("procedure_date")),
    str(formData, "finding"),
    intOrNull(formData.get("follow_up_interval_days")),
    str(formData, "notes"),
    providerId,
    id,
    profile.id
  );
  revalidateDental();
  return formOk();
}

export async function deleteDentalProcedure(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that record.");
  // Row-ops side-state (#199-#203, #700): a follow-up may link this record as its
  // SOURCE finding, or a resolution may cite it as the resolving record — both carry
  // a REFERENCES FK with no ON DELETE. NULL those links FIRST so the delete can't
  // trip the care_plan_items FK.
  unlinkFollowUpsForDentalProcedure(profile.id, id);
  db.prepare(
    "DELETE FROM dental_procedures WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidateDental();
  return formOk();
}

// Track a dental recheck follow-up (#700/#705 ask 5): creates a linked, OPEN
// care-plan item whose planned_date is the record date + the chosen interval, so a
// "watch #14, recheck in 6 months" finding becomes a tracked, legible, resolvable
// follow-up on Upcoming instead of a note that ages out. Idempotent per source
// record (a second click returns the existing one).
export async function trackDentalFollowUp(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const recordId = Number(formData.get("record_id"));
  const intervalDays = Number(formData.get("interval_days"));
  if (!recordId) return formError("Couldn't find that record.");
  if (!Number.isFinite(intervalDays) || intervalDays <= 0)
    return formError("Choose a follow-up interval.");
  const res = trackDentalFollowUpCore(
    profile.id,
    recordId,
    intervalDays,
    today(profile.id)
  );
  if (res.kind === "invalid") return formError("Couldn't find that record.");
  revalidateDental();
  revalidatePath("/upcoming");
  revalidatePath("/records");
  return formOk();
}
