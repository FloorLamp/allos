"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { formError, formOk, type FormResult } from "@/lib/types";
import { processPhoto } from "@/lib/photo/ingest";
import {
  addTrainingPhotoCore,
  deleteTrainingPhotoCore,
  updateTrainingPhotoCaptionCore,
  type TrainingPhotoOwner,
} from "@/lib/training-photo-write";
import { gateItemProfile } from "@/app/(app)/gate-item";

// Server Actions for TRAINING photos (#3285 item 3), the photo core's fourth tenant.
// The write shape is the core's step 3: gate → parse → processPhoto (magic-byte
// sniff, EXIF harvest, STRIP, downscale, thumbnail — never the client's word for any
// of it) → domain write core → revalidate. The gate is the shared gateItemProfile the
// clip actions beside these take, because the activity page mounts cross-profile in
// household multi-view: an explicit subject is write-gated with
// requireProfileWriteAccess, and a form that posts none falls back to
// requireWriteAccess on the acting profile.
//
// The stored file is metadata-free even when the client sends a GPS-tagged capture —
// proved at this boundary in lib/__action_tests__/training-photos.actions.test.ts,
// because no static scan can see across it.

// Both surfaces that show these photos, plus the record: an event page aggregates its
// linked activities' photos, so a session upload changes the event page too, and the
// media filter's predicate is a row's photo count.
function revalidateTrainingPhotoSurfaces() {
  revalidateRoute("/training/activity/[id]", "page");
  revalidateRoute("/training/event/[id]", "page");
  revalidateRoute("/history");
}

// The photo's owner, from the two mutually exclusive form fields. Null when neither
// or both arrived — the same exactly-one rule the schema CHECK and the core's union
// carry, refused here rather than reshaped into a default.
function ownerFrom(formData: FormData): TrainingPhotoOwner | null {
  const activityId = Number(formData.get("activity_id"));
  const planId = Number(formData.get("plan_id"));
  const hasActivity = Number.isInteger(activityId) && activityId > 0;
  const hasPlan = Number.isInteger(planId) && planId > 0;
  if (hasActivity === hasPlan) return null;
  return hasActivity
    ? { kind: "activity", activityId }
    : { kind: "event", planId };
}

// Attach a photo to a logged session or to an event.
export async function uploadTrainingPhotoAction(
  formData: FormData
): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const owner = ownerFrom(formData);
  if (!owner) return formError("That session is no longer available.");
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0)
    return formError("Choose a photo to attach.");
  const caption = String(formData.get("caption") ?? "").trim() || null;

  const processed = await processPhoto(Buffer.from(await file.arrayBuffer()));
  if (processed.kind === "invalid") return formError(processed.error);

  const outcome = addTrainingPhotoCore(
    profileId,
    owner,
    processed.photo,
    caption
  );
  if (outcome.kind === "invalid") return formError(outcome.error);
  // "duplicate" is a calm success: the identical capture is already attached, and the
  // event page shows its linked sessions' photos, so it is already where it belongs.
  revalidateTrainingPhotoSurfaces();
  return formOk();
}

// Correct the caption without replacing the image (#1934). The core's SET list holds
// the caption alone, so this can never re-point a row at different pixels.
export async function updateTrainingPhotoCaptionAction(
  formData: FormData
): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("photo_id"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That photo is no longer available.");
  if (
    !updateTrainingPhotoCaptionCore(
      profileId,
      id,
      String(formData.get("caption") ?? "")
    )
  )
    return formError("That photo is no longer available.");
  revalidateTrainingPhotoSurfaces();
  return formOk();
}

export async function deleteTrainingPhotoAction(
  formData: FormData
): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("photo_id"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That photo is no longer available.");
  if (!deleteTrainingPhotoCore(profileId, id))
    return formError("That photo is no longer available.");
  revalidateTrainingPhotoSurfaces();
  return formOk();
}
