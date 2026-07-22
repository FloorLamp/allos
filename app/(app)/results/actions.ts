"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { dismissFinding } from "@/lib/queries";
import { formError, formOk, type FormResult } from "@/lib/types";

// Dismiss a biomarker trajectory finding (issues #41/#564), from the Results →
// Biomarkers "Trajectory watch" area (#1164 moved it here from the deleted Trends →
// Biomarkers tab). The flag and the trajectory are two views of one concern about one
// analyte, so this writes the SHARED analyte-level acknowledgment key
// ("biomarker-flag:<family>") the finding carries as `supersedes` — silencing BOTH the
// trajectory watch and the analyte's dashboard flag ("dismiss once, silence
// everywhere"), at the #482 family level so it covers D2/D3/total. Guarded to the flag
// namespace so this action can only ever write a biomarker acknowledgment key;
// profile-scoped via dismissFinding.
export async function dismissTrajectory(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const ackKey = String(formData.get("ack_key") ?? "").trim();
  if (!ackKey.startsWith("biomarker-flag:"))
    return formError("Couldn't dismiss that finding.");
  dismissFinding(profile.id, ackKey);
  revalidatePath("/results/biomarkers");
  revalidatePath("/");
  return formOk();
}
