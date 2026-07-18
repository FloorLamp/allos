"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { isFlowLevel, type FlowLevel } from "@/lib/cycle";
import {
  createCycleRow,
  deleteCycleRow,
  getCycleRow,
  updateCycleRow,
} from "@/lib/cycle-store";
import { startPeriodCore, endPeriodCore } from "@/lib/cycle-write";

// Server Actions for the menstrual-cycle log (issue #714). Standard per-profile: every
// action operates on the session's ACTIVE profile behind requireWriteAccess() (the gate is
// inlined so the write-access scanner sees a literal call in each body), then delegates to
// the auth-blind write cores (#319) and revalidates. Cycle data rarely lives in documents,
// so entry is manual — no AI extraction path.

export type CycleActionResult = { ok: true } | { ok: false; error: string };
export type CycleCreateResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

function revalidateCycle() {
  revalidatePath("/medical/cycles");
  revalidatePath("/timeline");
  revalidatePath("/");
}

function parseFlow(formData: FormData): FlowLevel | null {
  const v = formData.get("flow");
  return isFlowLevel(v) ? v : null;
}

function parseId(formData: FormData): number | null {
  const n = Number(formData.get("id"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// One-tap "period started" (today, active profile).
export async function startPeriodAction(
  formData: FormData
): Promise<CycleActionResult> {
  const { profile } = await requireWriteAccess();
  const flow = parseFlow(formData);
  startPeriodCore(profile.id, today(profile.id), flow);
  revalidateCycle();
  return { ok: true };
}

// One-tap "period ended" (today, active profile).
export async function endPeriodAction(
  formData: FormData
): Promise<CycleActionResult> {
  const { profile } = await requireWriteAccess();
  void formData;
  const outcome = endPeriodCore(profile.id, today(profile.id));
  if (outcome.kind === "none-open") {
    return { ok: false, error: "Couldn't end the period. No period is open." };
  }
  if (outcome.kind === "invalid") {
    return { ok: false, error: "Enter an end on or after the period start." };
  }
  revalidateCycle();
  return { ok: true };
}

// Create or edit a period from the form (start, optional inclusive end, flow, note).
export async function saveCycleAction(
  formData: FormData
): Promise<CycleCreateResult> {
  const { profile } = await requireWriteAccess();
  const id = parseId(formData);
  const start = String(formData.get("period_start") ?? "");
  const endRaw = String(formData.get("period_end") ?? "").trim();
  const end = endRaw || null;
  const flow = parseFlow(formData);
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!isRealIsoDate(start)) {
    return { ok: false, error: "Enter a valid start date (YYYY-MM-DD)." };
  }
  if (end != null && !isRealIsoDate(end)) {
    return { ok: false, error: "Enter a valid end date (YYYY-MM-DD)." };
  }
  if (end != null && end < start) {
    return { ok: false, error: "Enter an end on or after the period start." };
  }

  if (id != null) {
    const existing = getCycleRow(profile.id, id);
    if (!existing) return { ok: false, error: "Couldn't find that period." };
    updateCycleRow(profile.id, id, start, end, flow, note);
    revalidateCycle();
    return { ok: true, id };
  }
  const newId = createCycleRow(profile.id, start, end, flow, note);
  revalidateCycle();
  return { ok: true, id: newId };
}

export async function deleteCycleAction(
  formData: FormData
): Promise<CycleActionResult> {
  const { profile } = await requireWriteAccess();
  const id = parseId(formData);
  if (id == null) return { ok: false, error: "Couldn't find that period." };
  const removed = deleteCycleRow(profile.id, id);
  if (!removed) return { ok: false, error: "Couldn't find that period." };
  revalidateCycle();
  return { ok: true };
}
