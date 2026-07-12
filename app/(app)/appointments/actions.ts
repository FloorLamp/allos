"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveProviderIdByName } from "@/lib/providers-db";
import { recordPreventiveDone } from "@/lib/queries";
import {
  isAppointmentKind,
  satisfiedRuleForCompletedKind,
} from "@/lib/preventive-appointment";
import {
  formError,
  formOk,
  type AppointmentStatus,
  type FormResult,
} from "@/lib/types";

// CRUD for scheduled medical visits. Every write is
// profile-scoped (profileId from requireWriteAccess) and revalidates the surfaces an
// appointment shows on. The optional provider is resolved through the shared,
// GLOBAL registry via a create-on-type name (like the immunizations form).

const str = (formData: FormData, key: string): string | null =>
  (formData.get(key) as string)?.trim() || null;

// The optional visit category, validated against the known kinds (a blank or
// tampered value is stored as NULL — which never matches a preventive rule).
const kindOf = (formData: FormData): string | null => {
  const raw = str(formData, "kind");
  return isAppointmentKind(raw) ? raw : null;
};

// Both the management page and the Upcoming aggregation reflect appointment
// changes, so keep their caches in lockstep.
function revalidate() {
  revalidatePath("/appointments");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

export async function createAppointment(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const scheduledAt = str(formData, "scheduled_at");
  // a visit with no date can't be scheduled
  if (!scheduledAt) return formError("Pick a date for this appointment.");
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `INSERT INTO appointments
       (profile_id, scheduled_at, provider_id, title, location, notes, kind, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`
  ).run(
    profile.id,
    scheduledAt,
    providerId,
    str(formData, "title"),
    str(formData, "location"),
    str(formData, "notes"),
    kindOf(formData)
  );
  revalidate();
  return formOk();
}

export async function updateAppointment(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const scheduledAt = str(formData, "scheduled_at");
  if (!id) return formError("Couldn't find that appointment.");
  if (!scheduledAt) return formError("Pick a date for this appointment.");
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `UPDATE appointments
       SET scheduled_at = ?, provider_id = ?, title = ?, location = ?, notes = ?, kind = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    scheduledAt,
    providerId,
    str(formData, "title"),
    str(formData, "location"),
    str(formData, "notes"),
    kindOf(formData),
    id,
    profile.id
  );
  revalidate();
  return formOk();
}

// Set the lifecycle status. 'completed'/'cancelled' drop the row off Upcoming;
// 'scheduled' returns it. Guarded to the known values.
async function setStatus(formData: FormData, status: AppointmentStatus) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare(
    "UPDATE appointments SET status = ? WHERE id = ? AND profile_id = ?"
  ).run(status, id, profile.id);
  revalidate();
}

export async function completeAppointment(formData: FormData) {
  await setStatus(formData, "completed");
}

export async function cancelAppointment(formData: FormData) {
  await setStatus(formData, "cancelled");
}

export async function reopenAppointment(formData: FormData) {
  await setStatus(formData, "scheduled");
}

export async function deleteAppointment(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that appointment.");
  db.prepare("DELETE FROM appointments WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidate();
  return formOk();
}

// Close the loop (issue #85): record the preventive satisfaction implied by a
// completed, kind-tagged appointment. The kind → rule mapping is derived server-side
// from the stored row (profile-scoped read), so a tampered form can't record an
// arbitrary rule; only the unambiguous single-rule kinds (physical/dental/vision)
// map, and the satisfaction is dated the visit's own day. Idempotent per
// (profile, rule, date) via recordPreventiveDone, so re-offering is a no-op. This
// complements — never duplicates — the record-inference layer: it lets a visit whose
// title doesn't name-match still complete its rule, using the explicit kind signal.
export async function recordPreventiveFromAppointment(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that appointment.");
  const row = db
    .prepare(
      "SELECT kind, scheduled_at FROM appointments WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as
    { kind: string | null; scheduled_at: string } | undefined;
  if (!row) return formError("Couldn't find that appointment.");
  const ruleKey = satisfiedRuleForCompletedKind(row.kind);
  if (!ruleKey) return formError("This visit maps to no preventive item.");
  recordPreventiveDone(
    profile.id,
    ruleKey,
    row.scheduled_at.slice(0, 10),
    "appointment"
  );
  revalidate();
  return formOk();
}
