"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { dismissFinding } from "@/lib/queries";

// Dismiss a biomarker trajectory finding (issues #41/#564), from the Results →
// Biomarkers "Trajectory watch" rollup (#1164 moved the area here from the deleted
// Trends → Biomarkers tab; #1499 folded it into one capped card). The flag and the
// trajectory are two views of one concern about one analyte, so this writes the
// SHARED analyte-level acknowledgment key ("biomarker-flag:<family>") the finding
// carries as `supersedes` — silencing BOTH the trajectory watch and the analyte's
// dashboard flag ("dismiss once, silence everywhere"), at the #482 family level so it
// covers D2/D3/total. Guarded to the flag namespace so this action can only ever
// write a biomarker acknowledgment key; profile-scoped via dismissFinding.
//
// The field is `dedupe_key`, the name every findings-bus dismiss form posts (the
// shared components/FindingRow renders it) — `ack_key` was this surface's own
// spelling for the same thing and is still accepted so an in-flight form submitted
// across a deploy is not silently dropped. Returns void, matching its Training-watch
// sibling `dismissTrainingObservation`: the rollup rows are FindingRow forms, whose
// action contract is a plain server action, and no caller ever read the old result.
export async function dismissTrajectory(formData: FormData): Promise<void> {
  const { profile } = await requireWriteAccess();
  const ackKey = String(
    formData.get("dedupe_key") ?? formData.get("ack_key") ?? ""
  ).trim();
  if (!ackKey.startsWith("biomarker-flag:")) return;
  dismissFinding(profile.id, ackKey);
  revalidatePath("/results/biomarkers");
  revalidatePath("/");
}
