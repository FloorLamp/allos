"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, today } from "@/lib/db";
import { requireWriteAccess } from "@/lib/auth";
import { getActiveSituations, setActiveSituations } from "@/lib/settings";
import { isRealIsoDate } from "@/lib/date";
import { normalizeOutcomeKeys } from "@/lib/protocol-metrics";
import { getProtocol, situationUsedByOtherProtocol } from "@/lib/queries";
import { getEquipmentById } from "@/lib/equipment";
import { parseScopedPractice } from "@/lib/protocol-practice";
import { formError, formOk, type FormResult } from "@/lib/types";

function revalidateProtocols(id?: number) {
  revalidatePath("/protocols");
  if (id) revalidatePath(`/protocols/${id}`);
  revalidatePath("/timeline");
  revalidatePath("/");
}

function str(formData: FormData, key: string): string | null {
  return String(formData.get(key) ?? "").trim() || null;
}

// Add a situation label to the profile's active set (idempotent), reusing the
// existing situations wiring so a started protocol surfaces its situational
// supplements exactly like a manual toggle.
function activateSituation(profileId: number, situation: string) {
  const next = new Set(getActiveSituations(profileId));
  next.add(situation);
  setActiveSituations(profileId, [...next]);
}

// Remove a situation label from the active set UNLESS another still-ongoing
// protocol declares it (row-side-state rule: a protocol's end/delete inverts the
// activation it caused, but must not clobber a situation a sibling protocol needs).
function deactivateSituation(
  profileId: number,
  situation: string,
  exceptProtocolId: number
) {
  if (situationUsedByOtherProtocol(profileId, situation, exceptProtocolId))
    return;
  const next = new Set(getActiveSituations(profileId));
  if (next.delete(situation)) setActiveSituations(profileId, [...next]);
}

// Resolve the optional recovery-gear reference: the submitted equipment id, but
// only if it's a real row for THIS profile (a leaked/foreign id becomes NULL
// rather than a dangling FK write).
function resolveEquipmentId(
  profileId: number,
  formData: FormData
): number | null {
  const raw = Number(formData.get("equipment_id"));
  if (!raw || !Number.isFinite(raw)) return null;
  return getEquipmentById(profileId, raw) ? raw : null;
}

// Resolve the optional intervention intake-item link (issue #660): the submitted
// intake_items id, but only if it's a real row for THIS profile (a leaked/foreign
// id becomes NULL rather than a dangling FK write) — the resolveEquipmentId shape.
function resolveIntakeItemId(
  profileId: number,
  formData: FormData
): number | null {
  const raw = Number(formData.get("intake_item_id"));
  if (!raw || !Number.isFinite(raw)) return null;
  const row = db
    .prepare("SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?")
    .get(raw, profileId);
  return row ? raw : null;
}

// The protocol's practice link BEFORE this save (nulls for a create).
interface PracticeLink {
  frequency_target_id: number | null;
  owns_frequency_target: number;
}

// Delete a protocol-OWNED frequency target, but only when no OTHER protocol now
// references it (row-ops rule: an owned target's cleanup must not strand a sibling
// protocol's reference). Profile-scoped.
function maybeDeleteOwnedTarget(
  profileId: number,
  targetId: number,
  exceptProtocolId: number
) {
  const other = db
    .prepare(
      `SELECT 1 FROM protocols
        WHERE profile_id = ? AND id != ? AND frequency_target_id = ? LIMIT 1`
    )
    .get(profileId, exceptProtocolId, targetId);
  if (!other)
    db.prepare(
      "DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?"
    ).run(targetId, profileId);
}

// Reconcile a protocol's practice (adherence) frequency target with the submitted
// form, deciding create-vs-reference EXPLICITLY (issue #344, row-ops rule):
//   • No practice submitted → unlink.
//   • Practice type already has a frequency target → REFERENCE it (owns=0), never
//     clobbering a pre-existing routine target's per-week — unless the protocol
//     already owned that exact target, in which case keep ownership and update it.
//   • Otherwise → CREATE a new owned target (owns=1).
// Returns the (target id, owns flag) to store on the protocol PLUS the id of a
// previously-OWNED target the protocol has moved off of, if any — the caller
// deletes that only AFTER the protocol row no longer references it (else the FK
// on protocols.frequency_target_id fails), via cleanupStaleOwnedTarget().
function syncPracticeTarget(
  profileId: number,
  formData: FormData,
  prev: PracticeLink
): PracticeLink & { staleOwnedTargetId: number | null } {
  // A practice can be an activity type OR a food group (#580) — parseScopedPractice
  // resolves the combined select value into (scopeKind, scopeValue). The create-vs-
  // reference + ownership machinery below is scope-agnostic, so both kinds reuse it.
  const practice = parseScopedPractice(
    str(formData, "practice_type"),
    formData.get("practice_per_week") as string | null
  );

  let tid: number | null = null;
  let owns = 0;

  if (practice) {
    const found = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = ? AND scope_value = ?
          LIMIT 1`
      )
      .get(profileId, practice.scopeKind, practice.scopeValue) as
      { id: number } | undefined;
    if (found) {
      tid = found.id;
      // If the protocol already OWNED this exact target, keep ownership and let the
      // edit update its per-week; otherwise reference it read-only (owns=0).
      if (prev.frequency_target_id === found.id && prev.owns_frequency_target) {
        owns = 1;
        db.prepare(
          `UPDATE frequency_targets SET per_week = ? WHERE id = ? AND profile_id = ?`
        ).run(practice.perWeek, found.id, profileId);
      }
    } else {
      const info = db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          profileId,
          practice.scopeKind,
          practice.scopeValue,
          practice.perWeek
        );
      tid = Number(info.lastInsertRowid);
      owns = 1;
    }
  }

  const staleOwnedTargetId =
    prev.frequency_target_id != null &&
    prev.owns_frequency_target &&
    prev.frequency_target_id !== tid
      ? prev.frequency_target_id
      : null;

  return {
    frequency_target_id: tid,
    owns_frequency_target: owns,
    staleOwnedTargetId,
  };
}

// Delete a now-stale owned target once the protocol row no longer references it.
// A no-op for null; profile-scoped via maybeDeleteOwnedTarget.
function cleanupStaleOwnedTarget(
  profileId: number,
  staleOwnedTargetId: number | null,
  exceptProtocolId: number
) {
  if (staleOwnedTargetId != null)
    maybeDeleteOwnedTarget(profileId, staleOwnedTargetId, exceptProtocolId);
}

export async function createProtocol(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Name your protocol.");
  const startRaw = str(formData, "start_date");
  const start =
    startRaw && isRealIsoDate(startRaw) ? startRaw : today(profile.id);
  const endRaw = str(formData, "end_date");
  const end = endRaw && isRealIsoDate(endRaw) ? endRaw : null;
  const notes = str(formData, "notes");
  const situation = str(formData, "situation");
  const outcomeKeys = normalizeOutcomeKeys(
    formData.getAll("outcome_keys").map((v) => String(v))
  );
  const equipmentId = resolveEquipmentId(profile.id, formData);
  const intakeItemId = resolveIntakeItemId(profile.id, formData);
  // On create there is no prior practice link, so no stale-target cleanup applies.
  const practice = syncPracticeTarget(profile.id, formData, {
    frequency_target_id: null,
    owns_frequency_target: 0,
  });

  const info = db
    .prepare(
      `INSERT INTO protocols
        (profile_id, name, start_date, end_date, notes, outcome_keys, situation,
         equipment_id, frequency_target_id, owns_frequency_target, intake_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      profile.id,
      name,
      start,
      end,
      notes,
      JSON.stringify(outcomeKeys),
      situation,
      equipmentId,
      practice.frequency_target_id,
      practice.owns_frequency_target,
      intakeItemId
    );

  // Starting an ongoing protocol activates its situation (if any).
  if (situation && !end) activateSituation(profile.id, situation);

  revalidateProtocols();
  redirect(`/protocols/${info.lastInsertRowid}`);
}

export async function updateProtocol(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that protocol.");
  const existing = getProtocol(profile.id, id);
  if (!existing) return formError("Couldn't find that protocol.");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Name your protocol.");
  const startRaw = str(formData, "start_date");
  const start =
    startRaw && isRealIsoDate(startRaw) ? startRaw : existing.start_date;
  const endRaw = str(formData, "end_date");
  const end = endRaw && isRealIsoDate(endRaw) ? endRaw : null;
  const notes = str(formData, "notes");
  const situation = str(formData, "situation");
  const outcomeKeys = normalizeOutcomeKeys(
    formData.getAll("outcome_keys").map((v) => String(v))
  );
  const equipmentId = resolveEquipmentId(profile.id, formData);
  const intakeItemId = resolveIntakeItemId(profile.id, formData);
  const practice = syncPracticeTarget(profile.id, formData, {
    frequency_target_id: existing.frequency_target_id,
    owns_frequency_target: existing.owns_frequency_target,
  });

  db.prepare(
    `UPDATE protocols
       SET name = ?, start_date = ?, end_date = ?, notes = ?,
           outcome_keys = ?, situation = ?, equipment_id = ?,
           frequency_target_id = ?, owns_frequency_target = ?,
           intake_item_id = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    name,
    start,
    end,
    notes,
    JSON.stringify(outcomeKeys),
    situation,
    equipmentId,
    practice.frequency_target_id,
    practice.owns_frequency_target,
    intakeItemId,
    id,
    profile.id
  );
  // Now that the protocol row no longer references the old target, clean it up.
  cleanupStaleOwnedTarget(profile.id, practice.staleOwnedTargetId, id);

  // Reconcile the situation activation with the edit: a removed/renamed situation
  // on an ongoing protocol is deactivated (unless a sibling needs it); a newly-set
  // situation on an ongoing protocol is activated.
  const wasOngoing = existing.end_date == null;
  if (existing.situation && existing.situation !== situation && wasOngoing) {
    deactivateSituation(profile.id, existing.situation, id);
  }
  if (situation && end == null) activateSituation(profile.id, situation);

  revalidateProtocols(id);
  return formOk();
}

export async function endProtocol(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that protocol.");
  const existing = getProtocol(profile.id, id);
  if (!existing) return formError("Couldn't find that protocol.");
  if (existing.end_date != null)
    return formError("That protocol has already ended.");
  const end = today(profile.id);
  db.prepare(
    "UPDATE protocols SET end_date = ? WHERE id = ? AND profile_id = ?"
  ).run(end, id, profile.id);
  // Ending the protocol inverts its situation activation.
  if (existing.situation)
    deactivateSituation(profile.id, existing.situation, id);
  revalidateProtocols(id);
  return formOk();
}

export async function deleteProtocol(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that protocol.");
  const existing = getProtocol(profile.id, id);
  if (!existing) return formError("Couldn't find that protocol.");
  db.prepare("DELETE FROM protocols WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  // Delete carries its side-state (row-ops rule): a practice frequency target this
  // protocol OWNED is removed too — but only after the protocol row is gone (else
  // the FK on protocols.frequency_target_id fails) and only when no sibling
  // protocol references it.
  if (existing.owns_frequency_target && existing.frequency_target_id != null)
    maybeDeleteOwnedTarget(profile.id, existing.frequency_target_id, id);
  // An ongoing protocol's situation activation is reversed (unless a sibling
  // protocol still needs it).
  if (existing.situation && existing.end_date == null)
    deactivateSituation(profile.id, existing.situation, id);
  revalidateProtocols();
  redirect("/protocols");
}
