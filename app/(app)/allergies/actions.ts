"use server";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import type { AllergyStatus } from "@/lib/types";

// Allergy writes (#179). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?`. Manual rows carry a NULL source/document_id
// so the per-document import delete-set never touches them.

function revalidateAllergies() {
  revalidatePath("/allergies");
  revalidatePath("/profile");
  revalidatePath("/");
}

function statusOf(raw: unknown): AllergyStatus {
  const v = String(raw ?? "").trim();
  return v === "inactive" || v === "resolved" ? v : "active";
}

export async function addAllergy(formData: FormData) {
  const { profile } = requireSession();
  const substance = String(formData.get("substance") ?? "").trim();
  if (!substance) return;
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
}

export async function updateAllergy(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  const substance = String(formData.get("substance") ?? "").trim();
  if (!id || !substance) return;
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
}

export async function deleteAllergy(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM allergies WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateAllergies();
}
