"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireProfileWriteAccess, requireWriteAccess } from "@/lib/auth";
import { formError, formOk, type FormResult } from "@/lib/types";
import { ingestVideo } from "@/lib/video/ingest";
import { posterBytesFrom } from "@/lib/video/poster";
import {
  addActivityVideoCore,
  updateActivityVideoCaptionCore,
  deleteActivityVideoCore,
  getActivityVideos,
} from "@/lib/activity-video-write";
import type { ActivityMediaView } from "@/components/activity/ActivityMediaStrip";

// Server Actions for the TRAINING activity-media domain (#1224 phase 1). The
// whole gate shape lives here (auth-blind cores below): requireWriteAccess →
// parse/validate → ingestVideo (sniff + caps, never the client type) → poster
// strip via the photo pipeline → domain write core → revalidate. A multi-view
// editor carries its subject profile explicitly and is gated against that
// profile; ordinary callers keep using the active profile. The core also checks
// that the activity belongs to the resolved profile.

function revalidateActivitySurfaces() {
  revalidateRoute("/training");
  revalidateRoute("/training/activity/[id]", "page");
  revalidateRoute("/trends");
  revalidateRoute("/");
}

async function targetProfileId(formData: FormData): Promise<number | null> {
  const raw = formData.get("profile_id");
  if (raw == null) return (await requireWriteAccess()).profile.id;
  const profileId = Number(raw);
  if (!Number.isInteger(profileId) || profileId <= 0) {
    await requireWriteAccess();
    return null;
  }
  await requireProfileWriteAccess(profileId);
  return profileId;
}

// Attach a clip to one of the profile's activities. `exercise` optionally names a
// lift for per-lift filtering.
export async function uploadActivityVideoAction(
  formData: FormData
): Promise<FormResult> {
  const profileId = await targetProfileId(formData);
  if (profileId == null)
    return formError("That activity is no longer available.");
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
    profileId,
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
  const profileId = await targetProfileId(formData);
  if (profileId == null) return formError("That clip is no longer available.");
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That clip is no longer available.");
  const caption = String(formData.get("caption") ?? "");
  if (!updateActivityVideoCaptionCore(profileId, id, caption))
    return formError("That clip is no longer available.");
  revalidateActivitySurfaces();
  return formOk();
}

// Delete a clip (row + on-disk files). Profile-scoped by id.
export async function deleteActivityVideoAction(
  formData: FormData
): Promise<FormResult> {
  const profileId = await targetProfileId(formData);
  if (profileId == null) return formError("That clip is no longer available.");
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return formError("That clip is no longer available.");
  deleteActivityVideoCore(profileId, id);
  revalidateActivitySurfaces();
  return formOk();
}

// Read the clips attached to one activity (#1457). The activity EDITOR is a client
// component reached from several entry points (Training Log, repeat, live resume),
// so it can't be handed clips from a server component the way the activity detail
// page is — it asks for them when it opens, and again after an
// upload/delete, since its own client state outlives the server re-render these
// actions trigger.
//
// Read-only, but still `requireWriteAccess`: the only caller is the editor's WRITE
// surface, and matching the gate of the actions beside it keeps this file's auth
// tier uniform (#319). Profile-scoped by the core query, so a forged activity id
// returns nothing rather than another profile's clips.
export async function listActivityMediaAction(
  activityId: number,
  subjectProfileId?: number
): Promise<
  { ok: true; media: ActivityMediaView[] } | { ok: false; error: string }
> {
  let profileId: number | null;
  if (subjectProfileId == null) {
    profileId = (await requireWriteAccess()).profile.id;
  } else if (Number.isInteger(subjectProfileId) && subjectProfileId > 0) {
    await requireProfileWriteAccess(subjectProfileId);
    profileId = subjectProfileId;
  } else {
    await requireWriteAccess();
    profileId = null;
  }
  if (profileId == null)
    return { ok: false, error: "That activity is no longer available." };
  if (!Number.isInteger(activityId) || activityId <= 0)
    return { ok: false, error: "That activity is no longer available." };
  return {
    ok: true,
    media: getActivityVideos(profileId, activityId).map((v) => ({
      id: v.id,
      exercise: v.exercise,
      caption: v.caption,
      kind: v.kind,
      hasLocation: v.has_location === 1,
      durationSec: v.duration_sec,
    })),
  };
}
