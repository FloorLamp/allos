"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidateRoute } from "@/lib/revalidate";
import { today } from "@/lib/db";
import {
  trackLabFollowUpCore,
  trackIopFollowUpCore,
} from "@/lib/followup-write";
import { formError, formOk, type FormResult } from "@/lib/types";

// Track a follow-up for a flagged lab reading (#700 labs adapter): creates a linked,
// open care-plan item whose planned_date is the reading date + the chosen interval.
// The write core is idempotent per #482 biomarker family. Interval is a whole number
// of days (the form offers 3/6/12-month presets).
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
  revalidateRoute("/results/readings/view", "page");
  revalidateRoute("/upcoming");
  revalidateRoute("/records");
  revalidateRoute("/");
  return formOk();
}

// Track a glaucoma follow-up for a flagged intraocular-pressure reading (#698 §6 /
// Part of #700). The write core is idempotent per profile: IOP is one bilateral
// question, so one workup covers both eyes. Resolution stays on the shared Upcoming
// action, which dispatches on source_kind='iop'.
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
  revalidateRoute("/results/readings/view", "page");
  revalidateRoute("/upcoming");
  revalidateRoute("/records");
  revalidateRoute("/");
  return formOk();
}
