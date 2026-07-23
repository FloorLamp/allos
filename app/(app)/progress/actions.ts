"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { formError, formOk, type FormResult } from "@/lib/types";
import { processPhoto } from "@/lib/photo/ingest";
import { resolvePhotoDate } from "@/lib/photo/policy";
import {
  addProgressPhotoCore,
  deleteProgressPhotoCore,
} from "@/lib/progress-photo-write";

// Server Actions for the physique progress-photo domain (#1119 phase 2). The
// whole gate shape lives here (auth-blind cores below): requireWriteAccess →
// parse/validate → photo core (processPhoto: sniff, EXIF-harvest-then-STRIP,
// auto-orient, downscale, thumbnail) → domain write core → revalidate.

// Add a progress photo. The uploaded bytes may come from the in-app camera
// (already canvas-clean) or a raw file — the server pipeline strips + downscales
// REGARDLESS (never trust the client). The photo's date defaults from the EXIF
// capture date harvested before the strip, else today.
export async function uploadProgressPhoto(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0)
    return formError("Choose a photo to add.");
  const pose = String(formData.get("pose") ?? "");
  const rawDate = String(formData.get("date") ?? "").trim() || null;
  const captionRaw = formData.get("caption");
  const caption = typeof captionRaw === "string" ? captionRaw : null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const processed = await processPhoto(buffer);
  if (processed.kind === "invalid") return formError(processed.error);

  const date = resolvePhotoDate(
    rawDate,
    processed.photo.captureDate,
    today(profile.id)
  );
  const outcome = addProgressPhotoCore(
    profile.id,
    { date, pose, caption },
    processed.photo
  );
  if (outcome.kind === "invalid") return formError(outcome.error);
  // "duplicate" is a success: the identical capture is already in the series.
  revalidatePath("/progress");
  // The "Progress photos" sidebar entry is data-gated by getNavRelevance
  // (relevanceKey "progress"), read once in the shared app layout — so the first
  // photo must revalidate "/" or the nav link stays hidden until an unrelated
  // reload (the sleep/mood precedent, #1282).
  revalidatePath("/");
  return formOk();
}

// Delete one progress photo (row + on-disk files). The core is profile-scoped by
// id, so a forged photo id from another profile is dropped.
export async function deleteProgressPhoto(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("photo_id"));
  if (!id) return formError("That photo is no longer available.");
  deleteProgressPhotoCore(profile.id, id);
  revalidatePath("/progress");
  // Deleting the last photo re-hides the nav entry — revalidate "/" so the shared
  // layout's nav relevance re-resolves, matching the upload path (#1282).
  revalidatePath("/");
  return formOk();
}
