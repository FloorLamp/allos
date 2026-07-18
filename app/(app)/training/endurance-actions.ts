"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  createEndurancePlanCore,
  updateEndurancePlanCore,
  setEndurancePlanStatusCore,
  deleteEndurancePlanCore,
} from "@/lib/endurance-plans";
import { isEnduranceDiscipline } from "@/lib/endurance-plan";
import { toKm } from "@/lib/units";
import type { DistanceUnit } from "@/lib/settings";
import { getUnitPrefs } from "@/lib/settings";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server write-path for endurance event plans (issue #839). The Training-overview plan bar
// posts here; each action owns the auth gate (requireWriteAccess — the write-access scanner
// sees a literal call in every action) + validation + revalidation, and delegates the SQL
// to the auth-blind profileId-first cores in lib/endurance-plans.ts. Plans surface on the
// Training overview, the Timeline (event day / completion milestone), and the calendar
// feed, so those are revalidated.

function revalidateEndurance(): void {
  revalidatePath("/training");
  revalidatePath("/timeline");
  // The plan-aware cardio arm rides the dashboard coaching widget + Upcoming too.
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// Parse the target time from HH:MM:SS or MM:SS (or blank) into seconds, or null.
function parseTargetTimeSec(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else if (parts.length === 1) sec = parts[0] * 60; // bare minutes
  else return null;
  return sec > 0 ? Math.round(sec) : null;
}

// The target distance is entered in the login's display unit (km/mi) → canonical km.
function parseDistanceKm(raw: string, unit: DistanceUnit): number {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return toKm(n, unit);
}

// Create a new active plan. Refuses a second active plan for the same discipline.
export async function createEndurancePlan(
  formData: FormData
): Promise<FormResult> {
  const { profile, login } = await requireWriteAccess();
  const discipline = String(formData.get("discipline") ?? "").trim();
  if (!isEnduranceDiscipline(discipline))
    return formError("Pick a discipline (run, ride, or swim).");
  const unit = getUnitPrefs(login.id).distanceUnit;
  const out = createEndurancePlanCore(profile.id, {
    eventName: String(formData.get("event_name") ?? ""),
    discipline,
    eventDate: String(formData.get("event_date") ?? "").trim(),
    targetDistanceKm: parseDistanceKm(
      String(formData.get("target_distance") ?? ""),
      unit
    ),
    targetTimeSec: parseTargetTimeSec(String(formData.get("target_time") ?? "")),
    notes: String(formData.get("notes") ?? ""),
  });
  if (out.kind === "duplicate")
    return formError(
      `You already have an active ${discipline} plan. Complete or abandon it first.`
    );
  if (out.kind !== "ok")
    return formError("Add an event date and a target distance.");
  revalidateEndurance();
  return formOk();
}

// Edit an existing plan in place.
export async function updateEndurancePlan(
  formData: FormData
): Promise<FormResult> {
  const { profile, login } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return formError("Invalid plan.");
  const discipline = String(formData.get("discipline") ?? "").trim();
  if (!isEnduranceDiscipline(discipline))
    return formError("Pick a discipline (run, ride, or swim).");
  const unit = getUnitPrefs(login.id).distanceUnit;
  const out = updateEndurancePlanCore(profile.id, id, {
    eventName: String(formData.get("event_name") ?? ""),
    discipline,
    eventDate: String(formData.get("event_date") ?? "").trim(),
    targetDistanceKm: parseDistanceKm(
      String(formData.get("target_distance") ?? ""),
      unit
    ),
    targetTimeSec: parseTargetTimeSec(String(formData.get("target_time") ?? "")),
    notes: String(formData.get("notes") ?? ""),
  });
  if (out.kind === "duplicate")
    return formError(`You already have another active ${discipline} plan.`);
  if (out.kind !== "ok")
    return formError("Add an event date and a target distance.");
  revalidateEndurance();
  return formOk();
}

// Mark a plan completed (a timeline milestone) or abandoned. Completing stamps the date.
export async function setEndurancePlanStatus(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "").trim();
  if (
    !Number.isInteger(id) ||
    !["active", "completed", "abandoned"].includes(status)
  )
    return formError("Invalid update.");
  const out = setEndurancePlanStatusCore(
    profile.id,
    id,
    status as "active" | "completed" | "abandoned",
    today(profile.id)
  );
  if (out.kind === "duplicate")
    return formError("Another active plan already holds this discipline.");
  if (out.kind !== "ok") return formError("Plan not found.");
  revalidateEndurance();
  return formOk();
}

// Delete a plan outright (a mistaken entry). Plain profile-scoped delete.
export async function deleteEndurancePlan(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return formError("Invalid plan.");
  if (!deleteEndurancePlanCore(profile.id, id))
    return formError("Plan not found.");
  revalidateEndurance();
  return formOk();
}
