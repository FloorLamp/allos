"use server";
import { requireSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { resolveProviderIdByName } from "@/lib/providers-db";

// Procedure / surgical-history writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/encounters), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns intact. The performing clinician is resolved through the
// shared GLOBAL providers registry via a create-on-type name.

function revalidateProcedures() {
  revalidatePath("/procedures");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addProcedure(formData: FormData) {
  const { profile } = requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `INSERT INTO procedures
       (name, code, code_system, date, provider_id, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,NULL,?)`
  ).run(
    name,
    str(formData, "code"),
    str(formData, "code_system"),
    dateOrNull(formData.get("date")),
    providerId,
    str(formData, "notes"),
    profile.id
  );
  revalidateProcedures();
}

export async function updateProcedure(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!id || !name) return;
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `UPDATE procedures
       SET name = ?, code = ?, code_system = ?, date = ?, provider_id = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    name,
    str(formData, "code"),
    str(formData, "code_system"),
    dateOrNull(formData.get("date")),
    providerId,
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateProcedures();
}

export async function deleteProcedure(formData: FormData) {
  const { profile } = requireSession();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM procedures WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateProcedures();
}
