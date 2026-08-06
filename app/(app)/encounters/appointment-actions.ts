"use server";

import { revalidatePath } from "next/cache";
import {
  completeAndLinkEncounterTx,
  setAppointmentStatus,
} from "@/lib/appointment-status";
import { requireWriteAccess } from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import { readForUpdate } from "@/lib/tx";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import { recordPreventiveDone, markCarePlanItemDone } from "@/lib/queries";
import {
  isAppointmentKind,
  satisfiedRuleForCompletedKind,
  APPOINTMENT_KIND_LABELS,
} from "@/lib/preventive-appointment";
import { carePlanDoneResult } from "@/lib/care-plan-upcoming";
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
  revalidatePath("/records");
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

// The one-tap status actions' typed result (#2134). `done` is the transition
// landing; `already` means the state the tap promised ALREADY stands (a second
// tap, another tab got there first) — an honest answer, not an error. A
// cross-state conflict (complete a cancelled row, cancel a completed one) and a
// missing/foreign row are refusals the caller renders.
export type AppointmentStatusResult =
  | { ok: true; outcome: "done" | "already" }
  | { ok: false; error: string };

// Set the lifecycle status through the CAS core (lib/appointment-status.ts).
// 'completed'/'cancelled' drop the row off Upcoming; 'scheduled' returns it.
// Revalidates on refusals too, so a stale row repaints to its true state and the
// controls it offers become honest again.
async function setStatus(
  formData: FormData,
  status: AppointmentStatus
): Promise<AppointmentStatusResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Couldn't find that appointment." };
  const outcome = setAppointmentStatus(profile.id, id, status);
  revalidate();
  switch (outcome.kind) {
    case "done":
      return { ok: true, outcome: "done" };
    case "not-found":
      return { ok: false, error: "Couldn't find that appointment." };
    case "already-scheduled":
    case "already-completed":
    case "already-cancelled": {
      // The target state already holds → idempotent success; any other standing
      // state is a conflict the tap must not overwrite.
      const current = outcome.kind.slice("already-".length);
      if (current === status) return { ok: true, outcome: "already" };
      return {
        ok: false,
        error:
          current === "completed"
            ? "This appointment was already completed — reopen it first."
            : "This appointment was cancelled — reopen it first.",
      };
    }
  }
}

export async function completeAppointment(
  formData: FormData
): Promise<AppointmentStatusResult> {
  return setStatus(formData, "completed");
}

export async function cancelAppointment(
  formData: FormData
): Promise<AppointmentStatusResult> {
  return setStatus(formData, "cancelled");
}

export async function reopenAppointment(
  formData: FormData
): Promise<AppointmentStatusResult> {
  return setStatus(formData, "scheduled");
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

// Close the care-plan loop (issue #658): completing an appointment offers to close
// the OPEN care-plan items it plausibly satisfied (a "colonoscopy in March" item vs
// the completed colonoscopy visit). The client computes the matches from the pure
// matcher (lib/care-plan-appointment) over the same open items the page passes it,
// then calls this per accepted item — always confirm-first, never a silent
// auto-complete. This is just the write behind that offer: mark the item completed
// (the shared markCarePlanItemDone), profile-scoped so a tampered id can only ever
// touch the acting profile's own care plan.
//
// The result carries the core's typed outcome (#2140): a re-mark of a completed item
// stays idempotent success, but a forged id or an item meanwhile cancelled answers
// with the shared refusal wording (carePlanDoneResult) the caller renders instead of
// the offer confirming a write that never happened.
export async function completeCarePlanItemFromAppointment(
  formData: FormData
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that care-plan item.");
  const outcome = markCarePlanItemDone(profile.id, id);
  revalidatePath("/records");
  revalidate();
  return carePlanDoneResult(outcome);
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
  // The guard read, the encounter INSERT, and the complete+link CAS share ONE
  // writeTx (#2134): a tap racing another tab can no longer insert an orphan
  // visit — the row is re-read under the write lock, and the appointment UPDATE
  // goes through the status core so the link swap carries its own expectation.
  const outcome = writeTx((tx) => {
    const row = readForUpdate<{
      scheduled_at: string;
      provider_id: number | null;
      title: string | null;
      notes: string | null;
      kind: string | null;
      encounter_id: number | null;
    }>(
      tx,
      db.prepare(
        `SELECT scheduled_at, provider_id, title, notes, kind, encounter_id
           FROM appointments WHERE id = ? AND profile_id = ?`
      ),
      id,
      profile.id
    );
    if (!row) return { kind: "not-found" as const };
    // Already logged — leave the existing linked visit in place (no duplicate).
    if (row.encounter_id != null) return { kind: "already-linked" as const };

    const res = db
      .prepare(
        `INSERT INTO encounters
           (profile_id, date, type, reason, notes, provider_id, source)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        profile.id,
        row.scheduled_at.slice(0, 10),
        encounterTypeForKind(row.kind),
        row.title,
        row.notes,
        row.provider_id
      );
    completeAndLinkEncounterTx(tx, profile.id, id, Number(res.lastInsertRowid));
    return { kind: "done" as const };
  });

  if (outcome.kind === "not-found") {
    return formError("Couldn't find that appointment.");
  }
  revalidate();
  revalidatePath("/profile");
  return formOk();
}
