"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";

// Care-plan writes. Session-scoped; every mutation is `WHERE id = ? AND
// profile_id = ?` and the INSERT carries profile_id. Manual rows carry a NULL
// source/document_id/external_id (like procedures/conditions), so the per-document
// import delete-set never touches them; editing an imported row leaves its
// provenance columns intact. The ordering clinician is resolved through the shared
// GLOBAL providers registry via a create-on-type name.

function revalidateCarePlan() {
  revalidatePath("/care-plan");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addCarePlanItem(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return formError("Enter the planned item.");
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `INSERT INTO care_plan_items
       (description, code, code_system, category, planned_date, status,
        provider_id, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    description,
    str(formData, "code"),
    str(formData, "code_system"),
    str(formData, "category"),
    dateOrNull(formData.get("planned_date")),
    str(formData, "status"),
    providerId,
    str(formData, "notes"),
    profile.id
  );
  revalidateCarePlan();
  return formOk();
}

export async function updateCarePlanItem(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const description = String(formData.get("description") ?? "").trim();
  if (!id) return formError("Couldn't find that care-plan item.");
  if (!description) return formError("Enter the planned item.");
  // Keep the existing link when the provider field wasn't touched (#601); re-resolve
  // only a genuine name change, so an unrelated edit can't relink an ambiguous name.
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `UPDATE care_plan_items
       SET description = ?, code = ?, code_system = ?, category = ?,
           planned_date = ?, status = ?, provider_id = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    description,
    str(formData, "code"),
    str(formData, "code_system"),
    str(formData, "category"),
    dateOrNull(formData.get("planned_date")),
    str(formData, "status"),
    providerId,
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateCarePlan();
  return formOk();
}

export async function deleteCarePlanItem(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that care-plan item.");
  db.prepare("DELETE FROM care_plan_items WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateCarePlan();
  return formOk();
}
