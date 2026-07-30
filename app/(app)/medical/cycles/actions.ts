"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { isFlowLevel, type FlowLevel } from "@/lib/cycle";
import {
  checkPeriodWrite,
  cycleRefusalMessage,
  REOPEN_PERIOD_MAX_AGE_DAYS,
} from "@/lib/cycle-plausibility";
import {
  createCycleRow,
  deleteCycleRow,
  getCycleRow,
  listCyclePeriods,
  updateCycleRow,
} from "@/lib/cycle-store";
import {
  startPeriodCore,
  endPeriodCore,
  reopenPeriodCore,
} from "@/lib/cycle-write";

// Server Actions for the menstrual-cycle log (issue #714). Standard per-profile: every
// action operates on the session's ACTIVE profile behind requireWriteAccess() (the gate is
// inlined so the write-access scanner sees a literal call in each body), then delegates to
// the auth-blind write cores (#319) and revalidates. Cycle data rarely lives in documents,
// so entry is manual — no AI extraction path.

export type CycleActionResult = { ok: true } | { ok: false; error: string };
export type CycleCreateResult =
  { ok: true; id: number } | { ok: false; error: string };

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

// One-tap "period started" (today, active profile). EVERY outcome of the core is mapped —
// two of them write nothing, and a handler must never confirm a write that did not happen
// (#1681 bug 1). The refusals revalidate too: each means the page the tap came from was
// stale, so the surface should re-render into the state that actually holds.
export async function startPeriodAction(
  formData: FormData
): Promise<CycleActionResult> {
  const { profile } = await requireWriteAccess();
  const flow = parseFlow(formData);
  const outcome = startPeriodCore(profile.id, today(profile.id), flow);
  revalidateCycle();
  if (outcome.kind === "already-open") {
    return {
      ok: false,
      error: "A period is already open — end it first.",
    };
  }
  if (outcome.kind === "duplicate") {
    return { ok: false, error: "A period already starts today." };
  }
  if (outcome.kind === "too-soon") {
    return {
      ok: false,
      error:
        `Your last period ended ${outcome.lastEnd}, too recently for a new one. ` +
        `Add it with dates below if that's right.`,
    };
  }
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

// One-tap "Still bleeding" (today, active profile) — reopens the most recently ended
// period after an early "Period ended" tap. Typed outcomes throughout; nothing is
// confirmed that wasn't written.
export async function reopenPeriodAction(
  formData: FormData
): Promise<CycleActionResult> {
  const { profile } = await requireWriteAccess();
  void formData;
  const outcome = reopenPeriodCore(profile.id, today(profile.id));
  revalidateCycle();
  if (outcome.kind === "not-found") {
    return { ok: false, error: "No recently ended period to reopen." };
  }
  if (outcome.kind === "already-open") {
    return { ok: false, error: "A period is already open." };
  }
  if (outcome.kind === "too-old") {
    return {
      ok: false,
      error:
        `That period ended ${outcome.lastEnd}, more than ` +
        `${REOPEN_PERIOD_MAX_AGE_DAYS} days ago — edit its end date below instead.`,
    };
  }
  return { ok: true };
}

// Create or edit a period from the form (start, optional inclusive end, flow, note).
// The form is the surface that owns the EXCEPTIONS the quick actions won't touch, so it
// carries the full plausibility gate (#1682): real dates, no future dates, no overlap with
// another recorded period, and never a second simultaneously-open period. Every refusal
// names its conflict; nothing is inferred or repaired on the user's behalf.
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

  // The shared plausibility gate — the same pure checks any future import path will run.
  // An edit is checked against its neighbors with its own row excluded, so re-saving a row
  // unchanged is never a conflict with itself, and moving one INTO an overlap is refused.
  const refusal = checkPeriodWrite(
    { id, start, end },
    listCyclePeriods(profile.id),
    today(profile.id)
  );
  if (refusal) return { ok: false, error: cycleRefusalMessage(refusal) };

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
