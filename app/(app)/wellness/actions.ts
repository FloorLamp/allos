"use server";

import { revalidateRoute } from "@/lib/revalidate";
import {
  LOGGED_VIA_FIELD,
  parseWebOrigin,
  type StampedFormData,
} from "@/lib/logged-via";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "../gate-item";
import { today } from "@/lib/db";
import {
  deletePracticeSession,
  endLivePracticeSession,
  logFinishedPracticeSession,
  logPracticeSession,
  startLivePracticeSession,
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
  type PracticeLiveEndOutcome,
  type PracticeLiveStartOutcome,
  type PracticeSessionMutationOutcome,
} from "@/lib/types";

function revalidatePracticeSurfaces() {
  revalidateRoute("/wellness");
  revalidateRoute("/history");
  revalidateRoute("/longevity");
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
// THE START IS PRESENCE-GATED, not value-gated (#2204). The expanded form always
// renders a Start input, so it always POSTS the field — empty when the user left it
// empty, which is a statement ("this session has no instant") the write core must hear
// as `null`. A one-tap path posts no `start_time` field at all, which is a different
// statement ("I have no opinion, you have the clock") and reaches the core as
// `undefined`, where it stamps the profile-local tap instant. Collapsing the two with
// `|| null` is what made every quick tap write a null time; the FormData distinction
// was already there, unused.
//
// `end_time` IS NOT PRESENCE-GATED, because it is not three-valued (#3142): a tap
// never states one, so "absent" and "empty" mean the same thing here — no stated end —
// and the window falls back to `duration_min` at read time.
//
// AND THE SUBJECT IS THE ROW'S, NOT THE ACTING ONE (#4424 ruling 4). Upcoming's
// multi-view rows mount the shared control, so a practice due on Sam's row must write
// to SAM: the control posts `profile_id` and `gateItemProfile` re-gates it through
// requireProfileWriteAccess (reachable AND write, redirect otherwise), falling back to
// the acting-profile gate when no subject is posted — which is every other mount,
// posting a byte-identical body. This is what replaced `logUpcomingPractice`'s own
// copy of the same two-branch gate.
export async function logPractice(
  formData: StampedFormData
): Promise<PracticeLogOutcome> {
  const profileId = await gateItemProfile(formData);
  const practice = String(formData.get("practice") ?? "").trim();
  if (!practice) return { kind: "invalid-date" };
  const date = String(formData.get("date") ?? "").trim() || today(profileId);
  if (formData.get("intent") === "finished") {
    const outcome = logFinishedPracticeSession(
      profileId,
      practice,
      parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
      optionalNumber(formData, "duration_min"),
      null,
      formData.has("end_time")
        ? {
            date,
            time: String(formData.get("end_time") ?? "").trim(),
          }
        : undefined
    );
    if (outcome.kind === "logged") revalidatePracticeSurfaces();
    return outcome;
  }
  const outcome = logPracticeSession(
    profileId,
    practice,
    date,
    // ONE ACTION, MANY MOUNTINGS (#3087). The shared row control renders on the
    // Wellness card, the dashboard protocol rows, the quick-log sheet and Upcoming's
    // practice row; the shared form renders in the card's modal, the backfill launcher
    // and both of the record's practice surfaces; and the command palette posts this
    // action directly with no component at all. The server cannot tell them apart, so
    // each mounting declares its own surface and the parse refuses anything outside
    // the web subset.
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    {
      startTime: formData.has("start_time")
        ? String(formData.get("start_time") ?? "").trim() || null
        : undefined,
      endTime: String(formData.get("end_time") ?? "").trim() || null,
      durationMin: optionalNumber(formData, "duration_min"),
      notes: String(formData.get("notes") ?? "").trim() || null,
    }
  );
  if (outcome.kind === "logged") revalidatePracticeSurfaces();
  return outcome;
}

// The live lifecycle takes the same subject as the log, for the same reason and by the
// same gate: a control mounted on a household member's row must not start the ACTING
// profile's session (#4424 ruling 4).
export async function startPracticeLive(
  formData: StampedFormData
): Promise<PracticeLiveStartOutcome> {
  const profileId = await gateItemProfile(formData);
  const practice = String(formData.get("practice") ?? "").trim();
  const outcome = startLivePracticeSession(
    profileId,
    practice,
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")
  );
  // `already-live` REVALIDATES TOO (#5431). The typed refusal means the server's row
  // disagrees with what the tapping surface was showing, and since the surfaces read
  // that row rather than keeping a copy of it, the correction has to reach them — a
  // Start tapped on a stale row otherwise leaves the row still offering Start.
  if (outcome.kind === "started" || outcome.kind === "already-live")
    revalidatePracticeSurfaces();
  return outcome;
}

export async function endPracticeLive(
  formData: FormData
): Promise<PracticeLiveEndOutcome> {
  const profileId = await gateItemProfile(formData);
  const outcome = endLivePracticeSession(profileId, Number(formData.get("id")));
  if (outcome.kind === "ended") revalidatePracticeSurfaces();
  return outcome;
}

export async function editPracticeSession(
  formData: FormData
): Promise<PracticeSessionMutationOutcome> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return { kind: "not-found" };
  const outcome = updatePracticeSession(profileId, id, {
    date: String(formData.get("date") ?? "").trim(),
    startTime: String(formData.get("start_time") ?? "").trim() || null,
    endTime: String(formData.get("end_time") ?? "").trim() || null,
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
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const notFound = { undoId: null, error: "Couldn't find that session." };
  if (!id) return notFound;
  const outcome = deletePracticeSession(profileId, id);
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
