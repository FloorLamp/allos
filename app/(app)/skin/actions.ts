"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  normalizeSkinLesionStatus,
  normalizeBodyRegion,
  normalizeBodySide,
  normalizeSizeMm,
  toFlag,
} from "@/lib/skin-lesion";
import {
  trackSkinFollowUpCore,
  unlinkFollowUpsForSkinLesion,
} from "@/lib/followup-write";
import {
  attachLesionPhotoCore,
  deleteLesionPhotoCore,
  deleteLesionPhotosForLesion,
} from "@/lib/skin-photo-write";

// Skin-lesion writes (#715). Session-scoped; every mutation is `WHERE id = ? AND
// profile_id = ?` and the INSERT carries profile_id. Manual rows carry a NULL
// source/document_id/external_id (like conditions/procedures), so the per-document
// import delete-set never touches them. status / body_region / body_side are normalized
// onto the DB CHECK sets through the ONE shared coercion in lib/skin-lesion (so a form
// value that isn't a valid enum can never trip the CHECK — it degrades to the safe
// default). The five ABCDE fields are USER-RECORDED OBSERVATIONS, never scored.

function revalidateSkin() {
  revalidatePath("/skin");
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

export async function addSkinLesion(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const label = str(formData, "label");
  const region = normalizeBodyRegion(formData.get("body_region"));
  if (!label && !region)
    return formError("Give the lesion a label or a body-map region.");
  db.prepare(
    `INSERT INTO skin_lesions
       (label, body_region, body_side, size_mm, asymmetry, border, color,
        diameter, evolving, status, observed_date, finding,
        follow_up_interval_days, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    label,
    region,
    normalizeBodySide(formData.get("body_side")),
    normalizeSizeMm(formData.get("size_mm")),
    toFlag(formData.get("asymmetry")),
    toFlag(formData.get("border")),
    toFlag(formData.get("color")),
    toFlag(formData.get("diameter")),
    toFlag(formData.get("evolving")),
    normalizeSkinLesionStatus(formData.get("status")),
    dateOrNull(formData.get("observed_date")),
    str(formData, "finding"),
    intOrNull(formData.get("follow_up_interval_days")),
    str(formData, "notes"),
    profile.id
  );
  revalidateSkin();
  return formOk();
}

export async function updateSkinLesion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that record.");
  const label = str(formData, "label");
  const region = normalizeBodyRegion(formData.get("body_region"));
  if (!label && !region)
    return formError("Give the lesion a label or a body-map region.");
  db.prepare(
    `UPDATE skin_lesions
       SET label = ?, body_region = ?, body_side = ?, size_mm = ?,
           asymmetry = ?, border = ?, color = ?, diameter = ?, evolving = ?,
           status = ?, observed_date = ?, finding = ?,
           follow_up_interval_days = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    label,
    region,
    normalizeBodySide(formData.get("body_side")),
    normalizeSizeMm(formData.get("size_mm")),
    toFlag(formData.get("asymmetry")),
    toFlag(formData.get("border")),
    toFlag(formData.get("color")),
    toFlag(formData.get("diameter")),
    toFlag(formData.get("evolving")),
    normalizeSkinLesionStatus(formData.get("status")),
    dateOrNull(formData.get("observed_date")),
    str(formData, "finding"),
    intOrNull(formData.get("follow_up_interval_days")),
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateSkin();
  return formOk();
}

export async function deleteSkinLesion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that record.");
  // Row-ops side-state (#199-#203, #700): a follow-up may link this lesion as its
  // SOURCE finding, or a resolution may cite it as the resolving record — both carry a
  // REFERENCES FK with no ON DELETE. Its photos carry a lesion_id REFERENCES FK too.
  // Clear all of them FIRST so the delete can't trip an FK.
  unlinkFollowUpsForSkinLesion(profile.id, id);
  deleteLesionPhotosForLesion(profile.id, id);
  db.prepare("DELETE FROM skin_lesions WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateSkin();
  return formOk();
}

// Track a skin recheck follow-up (#700/#715 ask 3): creates a linked, OPEN care-plan
// item whose planned_date is the observation date + the chosen interval, so a "watch
// this mole, recheck in 3 months" lesion becomes a tracked, legible, resolvable
// follow-up on Upcoming instead of a note that ages out. Idempotent per source record.
export async function trackSkinFollowUp(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const recordId = Number(formData.get("record_id"));
  const intervalDays = Number(formData.get("interval_days"));
  if (!recordId) return formError("Couldn't find that record.");
  if (!Number.isFinite(intervalDays) || intervalDays <= 0)
    return formError("Choose a follow-up interval.");
  const res = trackSkinFollowUpCore(
    profile.id,
    recordId,
    intervalDays,
    today(profile.id)
  );
  if (res.kind === "invalid") return formError("Couldn't find that record.");
  revalidateSkin();
  revalidatePath("/upcoming");
  revalidatePath("/care-plan");
  return formOk();
}

// Attach a dated photo to a lesion (#715 serial-photo tracking). Rides the existing
// upload posture (per-profile dir, sha256 dedup, profile-scoped serving). Server-sniffs
// the mime; the core re-checks the lesion belongs to the profile.
export async function uploadLesionPhoto(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const lesionId = Number(formData.get("lesion_id"));
  if (!lesionId) return formError("Couldn't find that lesion.");
  const date = String(formData.get("date") ?? "").trim() || today(profile.id);
  const caption = str(formData, "caption");
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0)
    return formError("Choose a photo to attach.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const outcome = attachLesionPhotoCore(
    profile.id,
    lesionId,
    date,
    buffer,
    file.name || "photo",
    caption
  );
  if (outcome.kind === "invalid") return formError(outcome.error);
  revalidateSkin();
  return formOk();
}

// Delete a lesion photo (row + on-disk file). The core is profile-scoped by id, so a
// forged photo id from another profile is dropped.
export async function deleteLesionPhoto(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("photo_id"));
  if (!id) return formError("That photo is no longer available.");
  deleteLesionPhotoCore(profile.id, id);
  revalidateSkin();
  return formOk();
}
