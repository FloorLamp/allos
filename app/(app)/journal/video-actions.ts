"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { formError, formOk, type FormResult } from "@/lib/types";
import { ingestVideo } from "@/lib/video/ingest";
import { posterBytesFrom } from "@/lib/video/poster";
import {
  addActivityVideoCore,
  updateActivityVideoCaptionCore,
  deleteActivityVideoCore,
} from "@/lib/activity-video-write";

// Server Actions for the TRAINING form-check video domain (#1224 phase 1). The
// whole gate shape lives here (auth-blind cores below): requireWriteAccess →
// parse/validate → ingestVideo (sniff + caps, never the client type) → poster
// strip via the photo pipeline → domain write core → revalidate. Active-profile
// scoped (the Journal is the acting profile's training surface, not a cross-
// profile household page); the core also verifies the activity belongs to the
// profile, so a forged activity id is rejected past the gate.

function revalidateActivitySurfaces() {
  revalidatePath("/training");
  revalidatePath("/trends");
  revalidatePath("/");
}

// Attach a clip to one of the profile's activities. `exercise` optionally names a
// lift for per-lift filtering.
export async function uploadActivityVideoAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const activityId = Number(formData.get("activityId"));
  if (!Number.isInteger(activityId) || activityId <= 0)
    return formError("That activity is no longer available.");
  const file = formData.get("video");
  if (!(file instanceof File) || file.size === 0)
    return formError("Choose a clip to attach.");
  const exercise = String(formData.get("exercise") ?? "").trim() || null;
  const caption = String(formData.get("caption") ?? "").trim() || null;

  const ingested = ingestVideo(Buffer.from(await file.arrayBuffer()));
  if (ingested.kind === "invalid") return formError(ingested.error);

  const poster = await posterBytesFrom(formData.get("poster"));

  const outcome = addActivityVideoCore(
    profile.id,
    { activityId, exercise, caption },
    ingested.video,
    poster
  );
  if (outcome.kind === "invalid") return formError(outcome.error);
  // "duplicate" is a success: the identical clip is already attached.
  revalidateActivitySurfaces();
  return formOk();
}

// Edit a clip's caption without replacing the file. Profile-scoped by id.
export async function updateActivityVideoCaptionAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That clip is no longer available.");
  const caption = String(formData.get("caption") ?? "");
  if (!updateActivityVideoCaptionCore(profile.id, id, caption))
    return formError("That clip is no longer available.");
  revalidateActivitySurfaces();
  return formOk();
}

// Delete a clip (row + on-disk files). Profile-scoped by id.
export async function deleteActivityVideoAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That clip is no longer available.");
  deleteActivityVideoCore(profile.id, id);
  revalidateActivitySurfaces();
  return formOk();
}
