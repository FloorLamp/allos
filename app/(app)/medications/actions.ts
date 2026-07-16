"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { deleteProfileSetting } from "@/lib/settings";
import {
  stopMedicationCourses,
  restartMedicationCourse,
  insertMedicationSideEffect,
  updateMedicationSideEffect,
  toggleMedicationSideEffectResolved,
  deleteMedicationSideEffect,
  promoteMedicationSideEffect,
  logAdministration,
} from "@/lib/queries";
import { getTimezone } from "@/lib/settings";
import { zonedWallTimeToUtc } from "@/lib/date";
import {
  normalizeStopReason,
  normalizeSeverity,
} from "@/lib/medication-history";
import { leftRefillTrackedSet, refillMarkerKey } from "@/lib/refill-nudge";
import { formError, formOk, type FormResult } from "@/lib/types";
import { strOrNull } from "@/lib/parse";
import { isRealIsoDate } from "@/lib/date";

// Medication-lifecycle write paths (#746): stop / restart / side effects for the
// standalone Medications page. Split out of the former combined /medicine action
// module — every action here shares the ONE auth tier (requireWriteAccess), so the
// #319 write-access scanner sees a uniform gate. The shared dose/item CRUD
// (add/update/toggle/delete an intake_item, dose check-offs) stays kind-agnostic in
// app/(app)/nutrition/supplement-actions.ts and is imported by the Medication card
// too. These are thin session wrappers over the profile-scoped lib/queries helpers,
// which own the transactions + ownership checks.

// Stop a medication: close its open course (reason + note) and clear `active`;
// optionally capture a side effect at stop time.
export async function stopMedication(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const before = db
    .prepare(
      "SELECT active, quantity_on_hand FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as
    { active: number; quantity_on_hand: number | null } | undefined;
  stopMedicationCourses(profile.id, id, {
    date: today(profile.id),
    reason: normalizeStopReason(formData.get("stop_reason")),
    note: strOrNull(formData.get("note")),
    effect: strOrNull(formData.get("effect")),
    severity: normalizeSeverity(formData.get("severity")),
  });
  // Stopping a tracked medication clears `active`, removing it from the refill-nudge
  // tracked set — so drop its low-supply episode marker, exactly as Pause does
  // (`toggleActive`), so a Restart while still low re-fires a fresh nudge instead of
  // being silenced by a stale marker (issue #325 parity: Stop/Restart mirrors
  // Pause/Resume).
  if (
    before &&
    leftRefillTrackedSet(
      { active: !!before.active, quantityOnHand: before.quantity_on_hand },
      { active: false, quantityOnHand: before.quantity_on_hand }
    )
  ) {
    deleteProfileSetting(profile.id, refillMarkerKey(id));
  }
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Restart a medication: open a NEW course dated today and set `active` back on.
export async function restartMedication(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  restartMedicationCourse(profile.id, id, today(profile.id));
  // Restart re-activates the med, putting a refill-tracked one back INTO the nudge
  // set — the enter-side twin of Stop's leave-side clear above. `leftRefillTrackedSet`
  // only fires on a LEAVE, so drop any lingering low-supply marker here directly, so a
  // med that still sits under threshold re-fires a fresh nudge (a stale marker whose
  // item is a candidate again isn't reached by the tick's self-healing sweep — #325).
  deleteProfileSetting(profile.id, refillMarkerKey(id));
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function addSideEffect(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id")); // the medication (item) id
  const effect = strOrNull(formData.get("effect"));
  if (!id) return formError("Couldn't find that medication.");
  if (!effect) return formError("Enter the side effect.");
  const notedRaw = strOrNull(formData.get("noted_on"));
  const courseRaw = Number(formData.get("course_id"));
  insertMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : today(profile.id),
    notes: strOrNull(formData.get("notes")),
    courseId: courseRaw > 0 ? courseRaw : null,
  });
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function updateSideEffect(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const effect = strOrNull(formData.get("effect"));
  if (!id) return formError("Couldn't find that side effect.");
  if (!effect) return formError("Enter the side effect.");
  const notedRaw = strOrNull(formData.get("noted_on"));
  updateMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : null,
    notes: strOrNull(formData.get("notes")),
    resolved:
      formData.get("resolved") === "1" || formData.get("resolved") === "on"
        ? 1
        : 0,
  });
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function toggleSideEffectResolved(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that side effect.");
  toggleMedicationSideEffectResolved(profile.id, id);
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function deleteSideEffect(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that side effect.");
  deleteMedicationSideEffect(profile.id, id);
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Resolve the quick-log offset the widget submits into the real intake time to
// store: "now" → undefined (the core stamps now); "30m"/"1h" → that many minutes
// ago; "custom" → an HH:MM wall time TODAY in the profile's timezone, converted to
// the absolute instant. "invalid" signals a malformed custom time. The far-off/
// future guard itself lives in the auth-blind core (isGivenAtAccepted, #614) so it
// covers the Telegram path too; this only shapes the offset into a Date.
function resolveGivenAt(
  profileId: number,
  offset: string,
  time: string | null
): Date | undefined | "invalid" {
  switch (offset) {
    case "30m":
      return new Date(Date.now() - 30 * 60 * 1000);
    case "1h":
      return new Date(Date.now() - 60 * 60 * 1000);
    case "custom": {
      if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return "invalid";
      return zonedWallTimeToUtc(getTimezone(profileId), today(profileId), time);
    }
    case "now":
    default:
      return undefined;
  }
}

// Log one PRN (as-needed) administration from the dashboard quick-log widget (#797).
// The auth gate + offset parsing live here; the write core (logAdministration) is
// auth-blind and shared with the Telegram /dose path, so "gave it now / 30m ago /
// 1h ago / at 4:02pm" is one computation. The updated count/last-time surfaces via
// revalidation rather than the FormResult (which carries no success payload).
export async function logMedicationAdministration(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const given = resolveGivenAt(
    profile.id,
    String(formData.get("offset") ?? "now"),
    strOrNull(formData.get("time"))
  );
  if (given === "invalid") return formError("Enter a valid time.");
  const outcome = logAdministration(profile.id, id, given);
  revalidatePath("/medications");
  revalidatePath("/nutrition");
  revalidatePath("/");
  switch (outcome.kind) {
    case "logged":
    case "duplicate":
      return formOk();
    case "invalid-time":
      return formError("That time is out of range — pick a time today.");
    case "inactive":
      return formError("This medication is paused — resume it to log a dose.");
    case "stale-item":
    default:
      return formError("Couldn't log that — it may have been removed.");
  }
}

// Promote a medication side effect into a manual allergies/intolerance row.
// The side effect is kept (marked resolved) for the medication's history.
export async function promoteSideEffectToIntolerance(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that side effect.");
  promoteMedicationSideEffect(profile.id, id, today(profile.id));
  revalidatePath("/medications");
  revalidatePath("/allergies");
  revalidatePath("/");
  return formOk();
}
