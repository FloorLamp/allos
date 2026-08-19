"use server";

import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidateRoute } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { detectNiggles } from "@/lib/niggle-extract";
import { reportNiggle, type ReportNiggleOutcome } from "@/lib/niggle-store";
import { isValidLaterality } from "@/lib/injury-model";

// The confirm chip's write (issue #2948, part 2). THE USER'S TAP IS THE WRITE
// (#798 confirm-never-silent): nothing about a detected niggle reaches the table until
// this action runs, and this action runs only from a tap.
//
// ── WHY THE ACTION RE-DERIVES THE CANDIDATE INSTEAD OF TRUSTING THE FORM ─────
//
// The chip posts a region and a side, but the action does not write them on the form's
// word. It re-reads the activity's stored `notes`, re-runs the SAME pure detector the
// chip was rendered from, and refuses unless the posted (region, laterality) is one of
// the candidates that note actually produces. Three things fall out of that:
//   • a stale tab cannot confirm a niggle for a note that has since been edited,
//   • a forged post cannot write a region the note never named — the surface of what
//     this action can store is exactly the surface the detector offered, and
//   • "the tap confirms what was shown" stops being a claim about the UI and becomes a
//     property of the server.
//
// Ownership is checked twice, deliberately: `gateItemProfile` write-gates the posted
// profile, and `reportNiggle` re-verifies that the source activity belongs to it, so a
// forged activity id cannot attach one profile's session to another profile's niggle.
export type ConfirmNiggleOutcome =
  | ReportNiggleOutcome
  | { ok: false; reason: "no-candidate" };

export async function confirmNiggle(
  formData: FormData
): Promise<ConfirmNiggleOutcome> {
  const profileId = await gateItemProfile(formData);
  const activityId = Number(formData.get("activity_id"));
  if (!Number.isInteger(activityId) || activityId <= 0)
    return { ok: false, reason: "not-owned" };

  const row = db
    .prepare(`SELECT notes FROM activities WHERE id = ? AND profile_id = ?`)
    .get(activityId, profileId) as { notes: string | null } | undefined;
  if (!row) return { ok: false, reason: "not-owned" };

  const rawLaterality = String(formData.get("laterality") ?? "");
  const laterality = isValidLaterality(rawLaterality) ? rawLaterality : null;
  const region = String(formData.get("region") ?? "");

  // The candidate list is already de-duplicated on (region, laterality) — the
  // `niggleKey` identity — so matching on the pair finds at most one. An invalid or
  // unknown region simply matches nothing, which makes this lookup the region
  // validation too: no second vocabulary check to drift out of step.
  const candidate = detectNiggles(row.notes).candidates.find(
    (c) => c.region === region && c.laterality === laterality
  );
  if (!candidate) return { ok: false, reason: "no-candidate" };

  const outcome = reportNiggle(profileId, {
    region: candidate.region,
    laterality: candidate.laterality,
    bodyTerm: candidate.bodyTerm,
    sourceActivityId: activityId,
    // The note names a body part, not a lift. `source_exercise` is left NULL rather
    // than guessed from the session's sets — attributing a knee to whichever exercise
    // happened to be logged that day is exactly the confident-wrong-answer this feature
    // must not produce. The column is written by callers that genuinely know one.
    sourceExercise: null,
  });

  if (outcome.ok) {
    revalidateRoute("/training/activity/[id]", "page");
    revalidateRoute("/training");
  }
  return outcome;
}
