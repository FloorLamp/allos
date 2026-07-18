"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { today } from "@/lib/db";
import {
  logMobilityMoveCore,
  unlogMobilityMoveCore,
  setMobilityDurationCore,
  type MobilitySession,
} from "@/lib/mobility-log-write";

// Server write-path for the mobility log (issue #840) — the tap-the-moves bar. A mobility
// session is ONE `activities` row of type `recovery` per (profile, date) whose components
// are the tapped moves. Toggling a move on/off and setting the overall duration each go
// through an auth-blind lib core (lib/mobility-log-write.ts); these actions own the auth
// gate + revalidation and answer with the session's AUTHORITATIVE post-write state so the
// bar reconciles its optimistic UI (the food-log #748 item 2 pattern).

export type MobilityLogResult =
  | { ok: true; session: MobilitySession }
  | { ok: false; error: string };

function resolveDate(formData: FormData, profileId: number): string {
  const raw = String(formData.get("date") ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today(profileId);
}

function revalidate(): void {
  revalidatePath("/training");
  revalidatePath("/");
}

// Add a move to the day's session (creating the row if absent). Idempotent.
export async function logMobilityMove(
  formData: FormData
): Promise<MobilityLogResult> {
  const { profile } = await requireWriteAccess();
  const slug = String(formData.get("move") ?? "").trim();
  const date = resolveDate(formData, profile.id);
  const outcome = logMobilityMoveCore(profile.id, slug, date);
  if (outcome.kind === "unknown-move")
    return { ok: false, error: "Unknown mobility move." };
  revalidate();
  return { ok: true, session: outcome.session };
}

// Remove a move from the day's session; deletes the row when it empties to nothing.
export async function unlogMobilityMove(
  formData: FormData
): Promise<MobilityLogResult> {
  const { profile } = await requireWriteAccess();
  const slug = String(formData.get("move") ?? "").trim();
  const date = resolveDate(formData, profile.id);
  const outcome = unlogMobilityMoveCore(profile.id, slug, date);
  if (outcome.kind === "unknown-move")
    return { ok: false, error: "Unknown mobility move." };
  revalidate();
  return { ok: true, session: outcome.session };
}

// Set (or clear) the session's optional overall duration in minutes.
export async function setMobilityDuration(
  formData: FormData
): Promise<MobilityLogResult> {
  const { profile } = await requireWriteAccess();
  const date = resolveDate(formData, profile.id);
  const raw = String(formData.get("minutes") ?? "").trim();
  const minutes = raw === "" ? null : Math.round(Number(raw));
  if (minutes != null && !Number.isFinite(minutes))
    return { ok: false, error: "Invalid duration." };
  const session = setMobilityDurationCore(profile.id, date, minutes);
  revalidate();
  return { ok: true, session };
}
