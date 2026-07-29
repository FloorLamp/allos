"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";

// Care-goal writes. Session-scoped; every mutation is `WHERE id = ? AND
// profile_id = ?` and the INSERT carries profile_id. Manual rows carry a NULL
// source/document_id/external_id, so the per-document import delete-set never
// touches them; editing an imported row leaves its provenance columns intact. NB:
// the care_goals table is DISTINCT from the `goals` table (personal fitness goals).

function revalidateCareGoals() {
  revalidatePath("/records");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addCareGoal(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return formError("Enter the goal.");
  db.prepare(
    `INSERT INTO care_goals
       (description, code, code_system, target_date, status, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,NULL,?)`
  ).run(
    description,
    str(formData, "code"),
    str(formData, "code_system"),
    dateOrNull(formData.get("target_date")),
    str(formData, "status"),
    str(formData, "notes"),
    profile.id
  );
  revalidateCareGoals();
  return formOk();
}

export async function updateCareGoal(formData: FormData): Promise<FormResult> {
  // Multi-view (#1328): gate + target the ROW's own profile; single-view falls back
  // to the acting profile.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const description = String(formData.get("description") ?? "").trim();
  if (!id) return formError("Couldn't find that goal.");
  if (!description) return formError("Enter the goal.");
  db.prepare(
    `UPDATE care_goals
       SET description = ?, code = ?, code_system = ?, target_date = ?,
           status = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    description,
    str(formData, "code"),
    str(formData, "code_system"),
    dateOrNull(formData.get("target_date")),
    str(formData, "status"),
    str(formData, "notes"),
    id,
    profileId
  );
  revalidateCareGoals();
  return formOk();
}

export async function deleteCareGoal(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that goal.");
  db.prepare("DELETE FROM care_goals WHERE id = ? AND profile_id = ?").run(
    id,
    profileId
  );
  revalidateCareGoals();
  return formOk();
}
