"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { dismissFinding } from "@/lib/queries";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";

// Dismiss a training-balance observation (issue #45, domain 4): a push/pull volume
// imbalance, a stale exercise, or a plateaued lift. Hides it through the shared
// findings-bus suppression store, keyed by its `training-obs:<kind>:…` dedupeKey.
// Guarded to the training-observation namespace (like dismissTrajectory) so this
// action can only ever silence a training-observation key; profile-scoped via
// dismissFinding.
export async function dismissTrainingObservation(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(TRAINING_OBS_PREFIX)) return;
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/training");
}
