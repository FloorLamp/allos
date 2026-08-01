"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { dismissFinding } from "@/lib/queries";
import { collectRightSizeCandidates } from "@/lib/rule-findings";
import {
  lowerFrequencyTargetFloor,
  stopTrackingFrequencyTarget,
} from "@/lib/target-rightsize-write";
import {
  RIGHTSIZE_OUTCOME_TEXT,
  RIGHTSIZE_PREFIX,
  rightSizeTargetIdFromKey,
} from "@/lib/target-rightsize";
import { formError, formOk, type FormResult } from "@/lib/types";

// The three decisions a frequency-target RIGHT-SIZING suggestion offers (issue #1670).
// They live here rather than under one domain's route because ONE detector serves
// three domains — wellness practices, training routines and food habits — and a
// suggestion's accept must behave identically wherever it is rendered.
//
// Every one of them takes the finding's dedupeKey and NOTHING else. The target id is
// derived from that single token (the #1505 precedent, itself the markDoseTaken rule),
// so an accept can never act on a commitment its own suggestion wasn't about, and the
// namespace guard means a tampered form cannot reach an arbitrary target.
//
// The accepts additionally RE-DERIVE the live candidate before writing. A card left
// open while the cadence recovered, or already accepted from another device, is stale
// — and a stale card must refuse rather than apply a floor nobody is suggesting any
// more. This is also why the new floor is never posted by the page: it is read from
// the detector, so the only number that can ever be written is the one the suggestion
// actually made.

// The candidate this dedupeKey names, if it is still being suggested.
function liveCandidate(profileId: number, dedupeKey: string) {
  const targetId = rightSizeTargetIdFromKey(dedupeKey);
  if (targetId == null) return null;
  return (
    collectRightSizeCandidates(profileId, today(profileId)).find(
      (c) => c.key === dedupeKey && c.targetId === targetId
    ) ?? null
  );
}

// Every surface a right-sized target can appear on. Accepting changes a weekly floor
// that the dashboard, Upcoming, and the domain's own page all render, so all of them
// are revalidated rather than the one page the tap happened on.
function revalidateRightSizeSurfaces(): void {
  revalidatePath("/wellness");
  revalidatePath("/nutrition");
  revalidatePath("/training");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// Accept "lower the weekly target": set the floor to the cadence the profile actually
// kept (the best week in the detector's window). Downward-only is enforced again at
// the write core, so this action cannot become a promotion path even by mistake.
export async function acceptRightSizeLower(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  const candidate = liveCandidate(profile.id, dedupeKey);
  if (!candidate) return formError(RIGHTSIZE_OUTCOME_TEXT.stale);
  // A candidate with nothing logged at all has no smaller positive floor to offer;
  // its card never renders this button, so reaching here means a stale form.
  if (candidate.suggestedFloor == null)
    return formError(RIGHTSIZE_OUTCOME_TEXT.stale);

  const outcome = lowerFrequencyTargetFloor(
    profile.id,
    candidate.targetId,
    candidate.suggestedFloor
  );
  if (outcome !== "lowered") return formError(RIGHTSIZE_OUTCOME_TEXT[outcome]);
  revalidateRightSizeSurfaces();
  return formOk();
}

// Accept "stop tracking": land in the domain's own no-expectation state — a logs-only
// practice, an untracked weekly routine, an untracked food habit. The ledger survives
// in every case, which is what the suggestion copy promises.
export async function acceptRightSizeStop(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  const candidate = liveCandidate(profile.id, dedupeKey);
  if (!candidate) return formError(RIGHTSIZE_OUTCOME_TEXT.stale);

  const outcome = stopTrackingFrequencyTarget(profile.id, candidate.targetId);
  if (outcome !== "stopped") return formError(RIGHTSIZE_OUTCOME_TEXT[outcome]);
  // The target row is gone, so the candidate can never be re-derived — but a
  // dismissal row keyed on a dead id would linger in "Snoozed & dismissed" as an
  // orphan, so nothing is written to the bus here. The suggestion clears because the
  // commitment did.
  revalidateRightSizeSurfaces();
  return formOk();
}

// Dismiss a right-sizing suggestion without acting on it — the calm half of the
// coaching-tier contract. Hides it through the shared findings-bus suppression store,
// guarded to the right-size namespace; profile-scoped via dismissFinding. The
// commitment is untouched: the user has said "keep asking".
export async function dismissRightSizeSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(RIGHTSIZE_PREFIX))
    return formError("Couldn't dismiss that suggestion.");
  dismissFinding(profile.id, dedupeKey);
  revalidateRightSizeSurfaces();
  return formOk();
}
