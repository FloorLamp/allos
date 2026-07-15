"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { dismissFinding } from "@/lib/queries";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";
import { MUSCLE_VOLUME_PREFIX } from "@/lib/muscle-volume-bands";
import {
  adoptTemplate,
  activateRoutine,
  createCustomRoutine,
  deactivateRoutine,
  deleteRoutine,
  updateRoutine,
  validateRoutineInput,
} from "@/lib/routines";

// Dismiss a Training-watch observation: a training-balance finding (issue #45, domain
// 4 — a push/pull volume imbalance, a stale exercise, or a plateaued lift) OR a
// per-muscle volume-band shortfall (#742). Hides it through the shared findings-bus
// suppression store, keyed by its `training-obs:…` / `muscle-volume:…` dedupeKey.
// Guarded to exactly those two Training-watch namespaces (like dismissTrajectory) so
// this action can only ever silence a Training-watch key; profile-scoped via
// dismissFinding.
export async function dismissTrainingObservation(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (
    !dedupeKey.startsWith(TRAINING_OBS_PREFIX) &&
    !dedupeKey.startsWith(MUSCLE_VOLUME_PREFIX)
  )
    return;
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/training");
}

// ── Routines (#738) ─────────────────────────────────────────────────────────────
// The auth boundary for the routine write cores (which are auth-blind, profileId-
// first, in lib/routines.ts): each action gates on requireWriteAccess, resolves the
// acting profile, calls the core, and revalidates. The builder UI (#739) and
// recommendation wiring (#740) build on these.

// Outcome the client reads after an activation attempt (never unconditionally
// confirm). `routineId` echoes the just-adopted routine so an adopt→activate flow can
// chain.
export type RoutineActionResult =
  { ok: true; routineId?: number } | { ok: false; error: string };

function routineIdFrom(formData: FormData): number | null {
  const id = Number(formData.get("routine_id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Adopt a catalog template — COPIES it into the profile's routine tables (inactive).
// Does not touch frequency targets (that's activation). #719 onboarding and the
// Training page call the same core.
export async function adoptRoutineTemplateAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const templateId = String(formData.get("template_id") ?? "").trim();
  if (!templateId) return { ok: false, error: "missing template" };
  try {
    const routineId = adoptTemplate(profile.id, templateId);
    revalidatePath("/training");
    return { ok: true, routineId };
  } catch {
    return { ok: false, error: "unknown template" };
  }
}

// Author a custom routine from a JSON `routine` payload (the builder form, #739,
// constructs it). Inactive until activated.
export async function createRoutineAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const input = parseRoutinePayload(formData);
  if (!input) return { ok: false, error: "invalid routine" };
  const routineId = createCustomRoutine(profile.id, input);
  revalidatePath("/training");
  return { ok: true, routineId };
}

// Edit an existing routine (rename + replace days/slots). Editing an adopted template
// is just editing your routine.
export async function updateRoutineAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const routineId = routineIdFrom(formData);
  if (routineId === null) return { ok: false, error: "missing routine" };
  const input = parseRoutinePayload(formData);
  if (!input) return { ok: false, error: "invalid routine" };
  const ok = updateRoutine(profile.id, routineId, input);
  if (!ok) return { ok: false, error: "not found" };
  revalidatePath("/training");
  return { ok: true, routineId };
}

// Activate a routine: single-active, and REPLACE the profile's training-scope
// frequency targets with the routine's derived ones (food_group untouched).
export async function activateRoutineAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const routineId = routineIdFrom(formData);
  if (routineId === null) return { ok: false, error: "missing routine" };
  const ok = activateRoutine(profile.id, routineId);
  if (!ok) return { ok: false, error: "not found" };
  revalidatePath("/training");
  revalidatePath("/");
  return { ok: true, routineId };
}

// Deactivate a routine (keeps the derived targets as ordinary user targets).
export async function deactivateRoutineAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const routineId = routineIdFrom(formData);
  if (routineId === null) return { ok: false, error: "missing routine" };
  const ok = deactivateRoutine(profile.id, routineId);
  if (!ok) return { ok: false, error: "not found" };
  revalidatePath("/training");
  revalidatePath("/");
  return { ok: true, routineId };
}

// Delete a routine and its days/slots (frequency targets are left in place).
export async function deleteRoutineAction(
  formData: FormData
): Promise<RoutineActionResult> {
  const { profile } = await requireWriteAccess();
  const routineId = routineIdFrom(formData);
  if (routineId === null) return { ok: false, error: "missing routine" };
  const ok = deleteRoutine(profile.id, routineId);
  if (!ok) return { ok: false, error: "not found" };
  revalidatePath("/training");
  return { ok: true, routineId };
}

// Parse + validate the `routine` JSON payload a builder form submits.
function parseRoutinePayload(formData: FormData) {
  const raw = formData.get("routine");
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateRoutineInput(parsed);
}
