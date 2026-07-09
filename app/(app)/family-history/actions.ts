"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

// Family-history writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions), so the per-document
// import delete-set never touches them.

function revalidateFamilyHistory() {
  revalidatePath("/family-history");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

// A whole-number age in a plausible range, or null.
function ageOrNull(raw: unknown): number | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 130 ? Math.round(n) : null;
}

// A checkbox → 1 when present/"on", else 0.
function boolInt(raw: unknown): number {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "on" || v === "1" || v === "true" ? 1 : 0;
}

export async function addFamilyHistory(formData: FormData) {
  const { profile } = requireWriteAccess();
  const condition = String(formData.get("condition") ?? "").trim();
  if (!condition) return;
  db.prepare(
    `INSERT INTO family_history
       (relation, condition, code, code_system, onset_age, deceased, notes,
        source, profile_id)
     VALUES (?,?,?,?,?,?,?,NULL,?)`
  ).run(
    str(formData, "relation"),
    condition,
    str(formData, "code"),
    str(formData, "code_system"),
    ageOrNull(formData.get("onset_age")),
    boolInt(formData.get("deceased")),
    str(formData, "notes"),
    profile.id
  );
  revalidateFamilyHistory();
}

export async function updateFamilyHistory(formData: FormData) {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  const condition = String(formData.get("condition") ?? "").trim();
  if (!id || !condition) return;
  db.prepare(
    `UPDATE family_history
       SET relation = ?, condition = ?, code = ?, code_system = ?,
           onset_age = ?, deceased = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    str(formData, "relation"),
    condition,
    str(formData, "code"),
    str(formData, "code_system"),
    ageOrNull(formData.get("onset_age")),
    boolInt(formData.get("deceased")),
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateFamilyHistory();
}

export async function deleteFamilyHistory(formData: FormData) {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM family_history WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateFamilyHistory();
}
