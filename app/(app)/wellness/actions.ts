"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  deletePracticeSession,
  logPracticeSession,
  updatePracticeSession,
} from "@/lib/practice-log";
import {
  createWellnessPractice,
  updateWellnessPractice,
} from "@/lib/practice-store";
import {
  formError,
  formOk,
  type FormResult,
  type PracticeLogOutcome,
  type PracticeSessionMutationOutcome,
} from "@/lib/types";

function revalidatePracticeSurfaces() {
  revalidatePath("/wellness");
  revalidatePath("/longevity");
  revalidatePath("/timeline");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

function optionalNumber(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Shared one-tap + expanded-detail action. A missing date means profile-local today;
// optional time/duration/notes are written only when the expanded form supplies them.
export async function logPractice(
  formData: FormData
): Promise<PracticeLogOutcome> {
  const { profile } = await requireWriteAccess();
  const practice = String(formData.get("practice") ?? "").trim();
  if (!practice) return { kind: "invalid-date" };
  const date = String(formData.get("date") ?? "").trim() || today(profile.id);
  const outcome = logPracticeSession(profile.id, practice, date, {
    time: String(formData.get("time") ?? "").trim() || null,
    durationMin: optionalNumber(formData, "duration_min"),
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  if (outcome.kind === "logged") revalidatePracticeSurfaces();
  return outcome;
}

export async function editPracticeSession(
  formData: FormData
): Promise<PracticeSessionMutationOutcome> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { kind: "not-found" };
  const outcome = updatePracticeSession(profile.id, id, {
    date: String(formData.get("date") ?? "").trim(),
    time: String(formData.get("time") ?? "").trim() || null,
    durationMin: optionalNumber(formData, "duration_min"),
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  if (outcome.kind === "updated") revalidatePracticeSurfaces();
  return outcome;
}

export async function removePracticeSession(
  formData: FormData
): Promise<PracticeSessionMutationOutcome> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { kind: "not-found" };
  const outcome = deletePracticeSession(profile.id, id);
  if (outcome.kind === "deleted") revalidatePracticeSurfaces();
  return outcome;
}

export async function savePractice(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const targetId = Number(formData.get("target_id")) || null;
  const name = String(formData.get("name") ?? "");
  const floor = Number(formData.get("per_week"));
  const ceiling = optionalNumber(formData, "per_week_max");
  const outcome =
    targetId == null
      ? createWellnessPractice(profile.id, name, floor, ceiling)
      : updateWellnessPractice(profile.id, targetId, name, floor, ceiling);
  if (outcome.kind === "invalid")
    return formError("Enter a practice name and a weekly target from 1 to 14.");
  if (outcome.kind === "duplicate")
    return formError("That practice already has a weekly target.");
  if (outcome.kind === "not-found")
    return formError("Couldn't find that practice.");
  revalidatePracticeSurfaces();
  return formOk();
}
