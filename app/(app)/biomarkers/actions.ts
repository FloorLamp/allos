"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidateRoute } from "@/lib/revalidate";
import { today } from "@/lib/db";
import {
  trackLabFollowUpCore,
  trackIopFollowUpCore,
} from "@/lib/followup-write";
import { formError, formOk, type FormResult } from "@/lib/types";

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
  revalidateRoute("/results");
  revalidateRoute("/biomarkers/view", "page");
  revalidateRoute("/upcoming");
  revalidateRoute("/records");
  revalidateRoute("/");
  return formOk();
}

// Track a GLAUCOMA follow-up for a flagged intraocular-pressure reading (#698 §6 /
// Part of #700). The IOP sibling of trackLabFollowUp: an elevated pressure becomes a
// tracked, resolvable "Recheck IOP / glaucoma workup" on Upcoming instead of a bare red
// dot. The write core is idempotent per profile (IOP is one bilateral question — a
// single workup covers both eyes), so a second click, or the other eye, returns the
// existing follow-up. Same shared resolve control + resolveFollowUp action as every
// other adapter (dispatches on source_kind='iop').
export async function trackIopFollowUp(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const recordId = Number(formData.get("record_id"));
  const intervalDays = Number(formData.get("interval_days"));
  if (!recordId) return formError("Couldn't find that reading.");
  if (!Number.isFinite(intervalDays) || intervalDays <= 0)
    return formError("Choose a follow-up interval.");
  const res = trackIopFollowUpCore(
    profile.id,
    recordId,
    intervalDays,
    today(profile.id)
  );
  if (res.kind === "invalid") return formError("Couldn't find that reading.");
  revalidateRoute("/results");
  revalidateRoute("/biomarkers/view", "page");
  revalidateRoute("/upcoming");
  revalidateRoute("/records");
  revalidateRoute("/");
  return formOk();
}
