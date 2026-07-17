"use server";

import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { today } from "@/lib/db";
import { zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { logTemperatureCore } from "@/lib/temperature-log";
import {
  logSymptomCore,
  setSymptomSeverityCore,
  lowerSymptomSeverityCore,
  setSymptomNoteCore,
  removeSymptomCore,
  renameCustomSymptomCore,
  deleteCustomSymptomCore,
} from "@/lib/symptom-log-write";
import {
  getActiveSituations,
  setActiveSituations,
} from "@/lib/settings/profile-attrs";
import { BUILTIN_ILLNESS_SITUATION } from "@/lib/situations";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server write-path for the symptom log (issue #799). The one-tap dashboard card and the
// Timeline day-view entry post here; each action owns the auth gate + validation +
// revalidation and delegates the SQL / worst-severity / #203 semantics to the auth-blind
// lib cores. Symptoms surface on the dashboard (illness-gated card) and the Timeline, so
// both are revalidated.

// The bar reconciles its optimistic chip to the server's authoritative severity (the
// FoodLogBar #748-item-2 pattern), so a dropped write can't leave a phantom chip.
export type SymptomLogResult =
  | { ok: true; symptom: string; severity: number }
  | { ok: false; error: string };

function parseDate(formData: FormData, profileId: number): string {
  const raw = String(formData.get("date") ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today(profileId);
}

function parseSeverity(formData: FormData): number {
  return Math.round(Number(formData.get("severity")));
}

function revalidateSymptoms(): void {
  revalidatePath("/");
  revalidatePath("/timeline");
}

// Cross-profile write gating for the illness hero (issue #858). The hero lets a caregiver
// log for a household member WITHOUT switching, so the bar may post an explicit
// `profileId`: when present the write is gated by requireProfileWriteAccess(target) — the
// #31 cross-profile gate that asserts the target is reachable AND write; when absent the
// write hits the session's ACTIVE profile via requireWriteAccess(). The default
// dashboard/Timeline symptom mounts send no profileId and are unaffected. The gate is
// inlined in EACH action (never a shared helper) so the write-access scanner
// (lib/__tests__/actions-write-access.test.ts) sees a literal requireWriteAccess() in
// every action body; the write cores stay auth-blind profileId-first (#319).

// Log (tap) a symptom at a severity — keeps the day's WORST severity (a tap only raises).
export async function logSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = logSymptomCore(
    profileId,
    symptom,
    parseSeverity(formData),
    parseDate(formData, profileId),
    String(formData.get("note") ?? "")
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't log that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Explicit edit: SET the severity exactly (may LOWER) and set the note exactly.
export async function editSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const { profile } = await requireWriteAccess();
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = setSymptomSeverityCore(
    profile.id,
    symptom,
    parseSeverity(formData),
    parseDate(formData, profile.id),
    String(formData.get("note") ?? "")
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't update that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Explicit LOWER (#857): drop a symptom-day's worst severity to a strictly lower value,
// preserving its note. Backs the bar's inline "Lower to mild?" confirm — a narrow action
// so a plain tap can never lower (it raises) and this can never raise.
export async function lowerSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = lowerSymptomSeverityCore(
    profileId,
    symptom,
    parseSeverity(formData),
    parseDate(formData, profileId)
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't lower that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Set (or clear) a logged symptom-day's note without touching its severity (#857). The
// note affordance on a logged row posts here; a blank note clears it.
export async function setSymptomNote(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = setSymptomNoteCore(
    profileId,
    symptom,
    parseDate(formData, profileId),
    String(formData.get("note") ?? "")
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't save that note." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Remove a symptom-day (the bar's undo).
export async function removeSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = removeSymptomCore(
    profileId,
    symptom,
    parseDate(formData, profileId)
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't find that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: 0 };
}

// Rename a custom symptom across all its log rows (#203 hygiene).
export async function renameCustomSymptom(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  const outcome = renameCustomSymptomCore(profile.id, from, to);
  if (outcome.kind === "invalid") return formError("Enter a new name.");
  if (outcome.kind === "not-custom")
    return formError("Only your own custom symptoms can be renamed.");
  revalidateSymptoms();
  return formOk();
}

// Delete a custom symptom entirely (#203 hygiene).
export async function deleteCustomSymptom(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("symptom") ?? "");
  const outcome = deleteCustomSymptomCore(profile.id, name);
  if (outcome.kind === "invalid")
    return formError("Couldn't find that symptom.");
  if (outcome.kind === "not-custom")
    return formError("Only your own custom symptoms can be deleted.");
  revalidateSymptoms();
  return formOk();
}

// Quick body-temperature log from the illness symptom card (issue #800). The bar posts
// a thermometer reading (°F/°C) that joins the EXISTING vitals series (canonical "Body
// Temperature", degF) via the auth-blind logTemperatureCore — the same table/identity as
// a Health Connect push, so it charts + flags like any other reading. The reading is
// timestamped: the entry is "now", so its profile-local clock time rides `notes` for the
// fever curve (multiple readings/day), and the caller may override with an explicit
// "HH:MM" for a backfilled reading. Temperature surfaces on the dashboard, Timeline,
// Trends, and the biomarkers browser, so all are revalidated.
export type TemperatureLogResult =
  | { ok: true; degF: number; flag: string | null }
  | { ok: false; error: string };

export async function logTemperature(
  formData: FormData
): Promise<TemperatureLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const rawValue = Number(formData.get("temperature"));
  const unit = String(formData.get("temp_unit") ?? "F");
  const date = parseDate(formData, profileId);
  // Prefer an explicit "HH:MM" (a backfilled reading); otherwise stamp the reading with
  // the profile-local clock time of "now" (thermometer-to-phone in one step).
  const providedTime = String(formData.get("time") ?? "").trim();
  const time = /^\d{2}:\d{2}$/.test(providedTime)
    ? providedTime
    : zonedDateParts(getTimezone(profileId), new Date()).hhmm;
  const outcome = logTemperatureCore(
    profileId,
    Number.isFinite(rawValue) ? rawValue : null,
    unit,
    date,
    time
  );
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidatePath("/");
  revalidatePath("/timeline");
  revalidatePath("/trends");
  revalidatePath("/biomarkers");
  return { ok: true, degF: outcome.degF, flag: outcome.flag };
}

// Symptom→situation bridge (issue #799, direction A): activate the built-in "Illness"
// situation so the day's symptoms fall inside an episode. Suggest-only from the UI — this
// action only ADDS Illness to the active set (idempotent), never deactivates anything.
export async function activateIllnessForSymptoms(): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const active = new Set(getActiveSituations(profile.id));
  if (!active.has(BUILTIN_ILLNESS_SITUATION)) {
    active.add(BUILTIN_ILLNESS_SITUATION);
    setActiveSituations(profile.id, [...active]);
  }
  revalidatePath("/");
  revalidatePath("/nutrition");
  revalidatePath("/timeline");
  return formOk();
}
