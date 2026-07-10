"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveProviderIdByName } from "@/lib/providers-db";
import type { AppointmentStatus } from "@/lib/types";

// CRUD for scheduled medical visits. Every write is
// profile-scoped (profileId from requireWriteAccess) and revalidates the surfaces an
// appointment shows on. The optional provider is resolved through the shared,
// GLOBAL registry via a create-on-type name (like the immunizations form).

const str = (formData: FormData, key: string): string | null =>
  (formData.get(key) as string)?.trim() || null;

// Both the management page and the Upcoming aggregation reflect appointment
// changes, so keep their caches in lockstep.
function revalidate() {
  revalidatePath("/appointments");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

export async function createAppointment(formData: FormData) {
  const { profile } = requireWriteAccess();
  const scheduledAt = str(formData, "scheduled_at");
  if (!scheduledAt) return; // a visit with no date can't be scheduled
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `INSERT INTO appointments
       (profile_id, scheduled_at, provider_id, title, location, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`
  ).run(
    profile.id,
    scheduledAt,
    providerId,
    str(formData, "title"),
    str(formData, "location"),
    str(formData, "notes")
  );
  revalidate();
}

export async function updateAppointment(formData: FormData) {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  const scheduledAt = str(formData, "scheduled_at");
  if (!id || !scheduledAt) return;
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `UPDATE appointments
       SET scheduled_at = ?, provider_id = ?, title = ?, location = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    scheduledAt,
    providerId,
    str(formData, "title"),
    str(formData, "location"),
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidate();
}

// Set the lifecycle status. 'completed'/'cancelled' drop the row off Upcoming;
// 'scheduled' returns it. Guarded to the known values.
async function setStatus(formData: FormData, status: AppointmentStatus) {
  const { profile } = requireWriteAccess();
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

export async function deleteAppointment(formData: FormData) {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM appointments WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidate();
}
