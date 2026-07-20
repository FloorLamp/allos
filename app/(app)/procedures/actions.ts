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

// Procedure / surgical-history writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/encounters), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns intact. The performing clinician is resolved through the
// shared GLOBAL providers registry via a create-on-type name.

function revalidateProcedures() {
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

export async function addProcedure(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Enter the procedure name.");
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
  return formOk();
}

export async function updateProcedure(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!id) return formError("Couldn't find that procedure.");
  if (!name) return formError("Enter the procedure name.");
  // Keep the loaded link unless the name was actually changed (#601).
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
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
  return formOk();
}

export async function deleteProcedure(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that procedure.");
  db.prepare("DELETE FROM procedures WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateProcedures();
  return formOk();
}
