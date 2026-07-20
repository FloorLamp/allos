"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  formError,
  formOk,
  type AllergyStatus,
  type FormResult,
} from "@/lib/types";

// Allergy writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?`. Manual rows carry a NULL source/document_id
// so the per-document import delete-set never touches them.

function revalidateAllergies() {
  revalidatePath("/records");
  revalidatePath("/profile");
  revalidatePath("/");
}

function statusOf(raw: unknown): AllergyStatus {
  const v = String(raw ?? "").trim();
  return v === "inactive" || v === "resolved" ? v : "active";
}

export async function addAllergy(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const substance = String(formData.get("substance") ?? "").trim();
  if (!substance) return formError("Enter the substance you're allergic to.");
  const reaction = String(formData.get("reaction") ?? "").trim() || null;
  const severity = String(formData.get("severity") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onsetRaw = String(formData.get("onset_date") ?? "").trim();
  const onset = isRealIsoDate(onsetRaw) ? onsetRaw : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  db.prepare(
    `INSERT INTO allergies
       (substance, reaction, severity, status, onset_date, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,NULL,?)`
  ).run(substance, reaction, severity, status, onset, notes, profile.id);
  revalidateAllergies();
  return formOk();
}

export async function updateAllergy(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const substance = String(formData.get("substance") ?? "").trim();
  if (!id) return formError("Couldn't find that allergy.");
  if (!substance) return formError("Enter the substance you're allergic to.");
  const reaction = String(formData.get("reaction") ?? "").trim() || null;
  const severity = String(formData.get("severity") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onsetRaw = String(formData.get("onset_date") ?? "").trim();
  const onset = isRealIsoDate(onsetRaw) ? onsetRaw : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  db.prepare(
    `UPDATE allergies
       SET substance = ?, reaction = ?, severity = ?, status = ?,
           onset_date = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(substance, reaction, severity, status, onset, notes, id, profile.id);
  revalidateAllergies();
  return formOk();
}

export async function deleteAllergy(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that allergy.");
  db.prepare("DELETE FROM allergies WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateAllergies();
  return formOk();
}
