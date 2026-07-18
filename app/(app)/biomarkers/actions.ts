"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, writeTx, today } from "@/lib/db";
import { isBiomarkerStarred, unstarBiomarkerFamily } from "@/lib/queries";
import { trackLabFollowUpCore } from "@/lib/followup-write";
import { formError, formOk, type FormResult } from "@/lib/types";

// Star / unstar a biomarker (toggles a starred_biomarkers row). Revalidates the
// surfaces that show the pinned card: /biomarkers and the dashboard.
export async function toggleStarBiomarker(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("canonical_name") ?? "").trim();
  if (!name) return;
  // Check-then-act as one atomic transaction so concurrent toggles can't both
  // read the same state and race (e.g. two inserts, or an insert lost to a delete).
  writeTx(() => {
    if (isBiomarkerStarred(profile.id, name)) {
      // Unstar the whole #482 family: a star on any member lights the family, so
      // clearing must remove every member's pin, not just this exact name (else the
      // toggle would read as still-starred).
      unstarBiomarkerFamily(profile.id, name);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)"
      ).run(profile.id, name);
    }
  });
  revalidatePath("/biomarkers");
  revalidatePath("/biomarkers/view", "page");
  revalidatePath("/");
}

// Track a follow-up for a FLAGGED biomarker reading (#700 labs adapter): creates a
// linked, OPEN care-plan item whose planned_date is the reading date + the chosen
// interval, so an out-of-range result ("A1c 8.2%") becomes a tracked, legible,
// resolvable "Recheck A1c" follow-up on Upcoming instead of falling through the cracks.
// The write core is idempotent per #482 biomarker family (a second click, or a sibling
// analyte of the same family, returns the existing one). Interval is a whole number of
// days (the form offers 3/6/12-month presets).
export async function trackLabFollowUp(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const recordId = Number(formData.get("record_id"));
  const intervalDays = Number(formData.get("interval_days"));
  if (!recordId) return formError("Couldn't find that reading.");
  if (!Number.isFinite(intervalDays) || intervalDays <= 0)
    return formError("Choose a follow-up interval.");
  const res = trackLabFollowUpCore(
    profile.id,
    recordId,
    intervalDays,
    today(profile.id)
  );
  if (res.kind === "invalid") return formError("Couldn't find that reading.");
  revalidatePath("/biomarkers");
  revalidatePath("/biomarkers/view", "page");
  revalidatePath("/upcoming");
  revalidatePath("/care-plan");
  revalidatePath("/");
  return formOk();
}
