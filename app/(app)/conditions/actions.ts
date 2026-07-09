"use server";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import type { ConditionStatus } from "@/lib/types";

// Condition / problem-list writes (#180). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?`. Manual rows carry a NULL source/document_id.

function revalidateConditions() {
  revalidatePath("/conditions");
  revalidatePath("/profile");
  revalidatePath("/");
}

function statusOf(raw: unknown): ConditionStatus {
  const v = String(raw ?? "").trim();
  return v === "inactive" || v === "resolved" ? v : "active";
}

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addCondition(formData: FormData) {
  const { profile } = requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const code = String(formData.get("code") ?? "").trim() || null;
  const codeSystem = String(formData.get("code_system") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onset = dateOrNull(formData.get("onset_date"));
  const resolved =
    status === "resolved" ? dateOrNull(formData.get("resolved_date")) : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  db.prepare(
    `INSERT INTO conditions
       (name, code, code_system, status, onset_date, resolved_date, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,?,NULL,?)`
  ).run(name, code, codeSystem, status, onset, resolved, notes, profile.id);
  revalidateConditions();
}

export async function updateCondition(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  const code = String(formData.get("code") ?? "").trim() || null;
  const codeSystem = String(formData.get("code_system") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onset = dateOrNull(formData.get("onset_date"));
  const resolved =
    status === "resolved" ? dateOrNull(formData.get("resolved_date")) : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  db.prepare(
    `UPDATE conditions
       SET name = ?, code = ?, code_system = ?, status = ?,
           onset_date = ?, resolved_date = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(name, code, codeSystem, status, onset, resolved, notes, id, profile.id);
  revalidateConditions();
}

export async function deleteCondition(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM conditions WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateConditions();
}
