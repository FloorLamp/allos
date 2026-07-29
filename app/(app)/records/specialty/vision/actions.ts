"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  normalizeOpticalKind,
  parseDiopter,
  parseEyeRefraction,
  parseMillimeters,
} from "@/lib/optical-prescription";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";

// Optical-prescription writes (#697). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/imaging_studies), so
// the per-document import delete-set never touches them; editing an imported row
// leaves its provenance intact. `kind` is normalized onto the DB CHECK set and the
// per-eye powers / axis / distances are parsed off the Rx notation through the ONE
// shared coercion in lib/optical-prescription (the same the import path uses), so a
// stray form value can never trip the CHECK.
//
// The prescriber provider link (provider_id) is populated only on the AI import path
// (which resolves the extracted optometrist name into the shared registry); this
// manual form doesn't offer a provider picker yet, so a manual Rx carries a NULL
// provider_id (the same stance imaging takes for its provider links). A provider
// merge still re-points it (PROVIDER_LINK_COLUMNS).

function revalidateVision() {
  // Vision folded into Health record (#1042 final tail): the surface is now
  // /records#vision.
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

// The full column list, in INSERT/UPDATE order, parsed from the form. Kept in one
// place so add and update stay in lock-step. Each eye's sphere/cyl/axis triple goes
// through the ONE shared coercion (parseEyeRefraction), which also canonicalizes a
// plus-cylinder entry onto minus-cylinder notation (#1036) — the form keeps
// accepting either notation as typed (users copy off the slip); the canonical form
// is what saves, and the form echoes it back on edit.
function rxValues(formData: FormData): unknown[] {
  const od = parseEyeRefraction(
    formData.get("od_sphere"),
    formData.get("od_cylinder"),
    formData.get("od_axis")
  );
  const os = parseEyeRefraction(
    formData.get("os_sphere"),
    formData.get("os_cylinder"),
    formData.get("os_axis")
  );
  return [
    normalizeOpticalKind(formData.get("kind")),
    od.sphere,
    od.cylinder,
    od.axis,
    parseDiopter(formData.get("od_add")),
    os.sphere,
    os.cylinder,
    os.axis,
    parseDiopter(formData.get("os_add")),
    parseMillimeters(formData.get("pd")),
    parseMillimeters(formData.get("base_curve")),
    parseMillimeters(formData.get("diameter")),
    str(formData, "brand"),
    dateOrNull(formData.get("issued_date")),
    dateOrNull(formData.get("expiry_date")),
    str(formData, "notes"),
  ];
}

export async function addOpticalPrescription(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  // The prescribing optometrist, resolved through the shared GLOBAL registry via a
  // create-on-type name (#1088). NULL for a self-entered Rx — never nagged.
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? ""),
    "individual"
  );
  db.prepare(
    `INSERT INTO optical_prescriptions
       (kind, od_sphere, od_cylinder, od_axis, od_add,
        os_sphere, os_cylinder, os_axis, os_add,
        pd, base_curve, diameter, brand, issued_date, expiry_date, notes,
        provider_id, source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(...rxValues(formData), providerId, profile.id);
  revalidateVision();
  return formOk();
}

export async function updateOpticalPrescription(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that prescription.");
  // Keep the loaded provider link unless the typed name actually changed (#601).
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? ""),
    "individual"
  );
  db.prepare(
    `UPDATE optical_prescriptions
       SET kind = ?, od_sphere = ?, od_cylinder = ?, od_axis = ?, od_add = ?,
           os_sphere = ?, os_cylinder = ?, os_axis = ?, os_add = ?,
           pd = ?, base_curve = ?, diameter = ?, brand = ?,
           issued_date = ?, expiry_date = ?, notes = ?, provider_id = ?
     WHERE id = ? AND profile_id = ?`
  ).run(...rxValues(formData), providerId, id, profile.id);
  revalidateVision();
  return formOk();
}

export async function deleteOpticalPrescription(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that prescription.");
  db.prepare(
    "DELETE FROM optical_prescriptions WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidateVision();
  return formOk();
}
