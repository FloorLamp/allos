"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  deletePracticeSession,
  logPracticeSession,
  updatePracticeSession,
} from "@/lib/practice-log";
import {
  createWellnessPractice,
  deleteWellnessPractice,
  untrackWellnessPractice,
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
  revalidateRoute("/wellness");
  revalidateRoute("/longevity");
  revalidateRoute("/timeline");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
}

function optionalNumber(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Shared one-tap + expanded-detail action. A missing date means profile-local today;
// optional duration/notes are written only when the form supplies them.
//
// TIME IS PRESENCE-GATED, not value-gated (#2204). The expanded form always renders a
// time input, so it always POSTS the field — empty when the user left it empty, which
// is a statement ("this session has no instant") the write core must hear as `null`.
// A one-tap path posts no `time` field at all, which is a different statement ("I have
// no opinion, you have the clock") and reaches the core as `undefined`, where it stamps
// the profile-local tap instant. Collapsing the two with `|| null` is what made every
// quick tap write a null time; the FormData distinction was already there, unused.
export async function logPractice(
  formData: FormData
): Promise<PracticeLogOutcome> {
  const { profile } = await requireWriteAccess();
  const practice = String(formData.get("practice") ?? "").trim();
  if (!practice) return { kind: "invalid-date" };
  const date = String(formData.get("date") ?? "").trim() || today(profile.id);
  const outcome = logPracticeSession(profile.id, practice, date, {
    time: formData.has("time")
      ? String(formData.get("time") ?? "").trim() || null
      : undefined,
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

// Remove ONE logged session. Answers in the `{ undoId }` shape `useUndoableDelete`
// consumes (#2038), so the history row gets the same Undo toast every other "remove one
// logged event" surface offers; a missing/stale id carries the message instead of a token.
export async function removePracticeSession(
  formData: FormData
): Promise<{ undoId: number | null; error?: string }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const notFound = { undoId: null, error: "Couldn't find that session." };
  if (!id) return notFound;
  const outcome = deletePracticeSession(profile.id, id);
  if (outcome.kind !== "deleted") return notFound;
  revalidatePracticeSurfaces();
  return { undoId: outcome.undoId };
}

export async function savePractice(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const targetId = Number(formData.get("target_id")) || null;
  const name = String(formData.get("name") ?? "");
  const floor = Number(formData.get("per_week"));
  const ceilingRaw = String(formData.get("per_week_max") ?? "").trim();
  const ceiling = ceilingRaw ? Number(ceilingRaw) : null;
  const outcome =
    targetId == null
      ? createWellnessPractice(profile.id, name, floor, ceiling)
      : updateWellnessPractice(profile.id, targetId, name, floor, ceiling);
  if (outcome.kind === "invalid") {
    if (outcome.reason === "name") return formError("Enter a practice name.");
    if (outcome.reason === "minimum-range")
      return formError(
        "The weekly minimum must be a whole number from 1 to 14."
      );
    if (outcome.reason === "maximum-range")
      return formError(
        "The weekly maximum must be a whole number from 1 to 14."
      );
    return formError("The weekly maximum must be greater than the minimum.");
  }
  if (outcome.kind === "duplicate")
    return formError("A practice with that name already exists.");
  if (outcome.kind === "not-found")
    return formError("Couldn't find that practice.");
  revalidatePracticeSurfaces();
  return formOk();
}

export async function untrackPractice(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const targetId = Number(formData.get("target_id"));
  if (!targetId) return formError("Couldn't find that practice.");
  const outcome = untrackWellnessPractice(profile.id, targetId);
  if (outcome.kind === "not-found")
    return formError("Couldn't find that practice.");
  revalidatePracticeSurfaces();
  return formOk();
}

export async function deletePractice(
  formData: FormData
): Promise<{ undoId: number | null; error?: string }> {
  const { profile } = await requireWriteAccess();
  const targetId = Number(formData.get("target_id")) || null;
  const practice = String(formData.get("practice") ?? "").trim();
  if (targetId == null && !practice)
    return { undoId: null, error: "Couldn't find that practice." };
  const outcome = deleteWellnessPractice(profile.id, targetId, practice);
  if (outcome.kind === "not-found")
    return { undoId: null, error: "Couldn't find that practice." };
  revalidatePracticeSurfaces();
  return { undoId: outcome.undoId };
}
