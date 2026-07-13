"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import { recordPreventiveDone } from "@/lib/queries";
import {
  isAppointmentKind,
  satisfiedRuleForCompletedKind,
  APPOINTMENT_KIND_LABELS,
} from "@/lib/preventive-appointment";
import {
  formError,
  formOk,
  type AppointmentKind,
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

// Both the merged Visits page and the Upcoming aggregation reflect appointment
// changes, so keep their caches in lockstep. Appointments and encounters now share
// the /encounters surface (issue #288), so that's the one page path to revalidate.
function revalidate() {
  revalidatePath("/encounters");
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
  // Keep the loaded link unless the provider field was actually changed (#601).
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
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

// The encounter type an appointment kind implies for a logged visit — the same
// human labels the form select shows, so a "Physical / check-up" appointment
// becomes an "Physical / check-up" encounter type. NULL kind → NULL type.
function encounterTypeForKind(kind: string | null): string | null {
  return isAppointmentKind(kind)
    ? APPOINTMENT_KIND_LABELS[kind as AppointmentKind]
    : null;
}

// "Log this visit" (issue #288): close the appointment → encounter loop by hand.
// Completing an appointment offers creating a linked encounter PREFILLED from it —
// the visit date, the linked provider, and the kind mapped to an encounter type —
// then marks the appointment completed and records the appointment.encounter_id
// back-link. This gives the overdue-appointment nudge a real resolution (a logged
// visit) instead of the row just disappearing on a bare status flip.
//
// Idempotent: an appointment already linked to an encounter is a no-op (the
// existing link stands, no duplicate visit). The new encounter is a MANUAL row
// (source NULL) — it carries no document provenance, so a later document import/
// delete never touches it, exactly like a hand-added visit. Profile-scoped on both
// the read and every write.
export async function logVisitFromAppointment(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that appointment.");
  const row = db
    .prepare(
      `SELECT scheduled_at, provider_id, title, notes, kind, encounter_id
         FROM appointments WHERE id = ? AND profile_id = ?`
    )
    .get(id, profile.id) as
    | {
        scheduled_at: string;
        provider_id: number | null;
        title: string | null;
        notes: string | null;
        kind: string | null;
        encounter_id: number | null;
      }
    | undefined;
  if (!row) return formError("Couldn't find that appointment.");
  // Already logged — leave the existing linked visit in place (no duplicate).
  if (row.encounter_id != null) {
    revalidate();
    return formOk();
  }

  const date = row.scheduled_at.slice(0, 10);
  writeTx(() => {
    const res = db
      .prepare(
        `INSERT INTO encounters
           (profile_id, date, type, reason, notes, provider_id, source)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        profile.id,
        date,
        encounterTypeForKind(row.kind),
        row.title,
        row.notes,
        row.provider_id
      );
    const encounterId = Number(res.lastInsertRowid);
    db.prepare(
      `UPDATE appointments SET status = 'completed', encounter_id = ?
         WHERE id = ? AND profile_id = ?`
    ).run(encounterId, id, profile.id);
  });

  revalidate();
  revalidatePath("/profile");
  return formOk();
}
