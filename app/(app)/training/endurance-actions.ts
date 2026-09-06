"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  createEndurancePlanCore,
  updateEndurancePlanCore,
  setEndurancePlanStatusCore,
  deleteEndurancePlanCore,
  linkEventActivityCore,
  unlinkEventActivityCore,
  type EndurancePlanPatch,
} from "@/lib/endurance-plans";
import {
  isEnduranceDiscipline,
  type EndurancePlanDiscipline,
} from "@/lib/endurance-plan";
import { toKm, submittedDistanceUnit } from "@/lib/units";
import type { DistanceUnit } from "@/lib/settings";
import { getUnitPrefs } from "@/lib/settings";
import { formError, formOk, type FormResult } from "@/lib/types";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import { isTrainingRelevant } from "@/lib/life-stage";

// The one message for every shape the core calls invalid, and the pair rule is the
// half a user can actually hit: a discipline with no distance, or a distance with no
// discipline. Naming both sides is what makes the error actionable rather than a
// re-statement of "that didn't work".
const TARGET_PAIR_ERROR =
  "Add an event date. A discipline and a target distance go together — set both, or neither.";

function trainingUnavailable(profileId: number): FormResult | null {
  return isTrainingRelevant(getProfileAge(profileId))
    ? null
    : formError("Training plans aren’t available for this profile’s age.");
}

// Server write-path for endurance event plans (issue #839). The Training-overview plan bar
// posts here; each action owns the auth gate (requireWriteAccess — the write-access scanner
// sees a literal call in every action) + validation + revalidation, and delegates the SQL
// to the auth-blind profileId-first cores in lib/endurance-plans.ts. Plans surface on the
// Training overview, the Timeline (event day / completion milestone), and the calendar
// feed, so those are revalidated.

function revalidateEndurance(): void {
  revalidateRoute("/training");
  // The event page (#3285 item 2) reads the plan, its day and its linked result.
  revalidateRoute("/training/event/[id]", "page");
  revalidateRoute("/history");
  // The plan-aware cardio arm rides the dashboard coaching atom + Upcoming too.
  revalidateRoute("/upcoming");
  revalidateRoute("/");
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
  else if (parts.length === 1)
    sec = parts[0] * 60; // bare minutes
  else return null;
  return sec > 0 ? Math.round(sec) : null;
}

// The unit the target distance was CAPTURED in (#630, #3942's distance twin): the plan
// bar labels the field "Target distance (mi)" from a server prop and the write can fire
// long after, so the form posts that unit and this trusts it over the login's current
// stored pref — which another tab or device can flip in between, since the pref is per
// LOGIN. Falls back to the stored pref when the field is absent (older client, or the
// PATCH action's callers, which carry no surface of their own yet).
function capturedDistanceUnit(
  formData: FormData,
  loginId: number
): DistanceUnit {
  return submittedDistanceUnit(
    formData.get("distance_unit"),
    getUnitPrefs(loginId).distanceUnit
  );
}

// The target distance is entered in the login's display unit (km/mi) → canonical km.
// NULL for a blank field since #3285: an event without a cardio target leaves it empty,
// and the core refuses a distance without a discipline (and the reverse) as a PAIR.
function parseDistanceKm(raw: string, unit: DistanceUnit): number | null {
  const t = String(raw).trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 fails the core's band → "invalid"
  return toKm(n, unit);
}

// The submitted discipline: a known one, `null` for the blank option (an event with no
// cardio arm), or `undefined` for a value that is neither — which the caller refuses
// rather than silently storing as "no discipline".
function parseDiscipline(
  raw: FormDataEntryValue | null
): EndurancePlanDiscipline | null | undefined {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  return isEnduranceDiscipline(t) ? t : undefined;
}

// Create a new active plan. Refuses a second active plan for the same discipline.
export async function createEndurancePlan(
  formData: FormData
): Promise<FormResult> {
  const { profile, login } = await requireWriteAccess();
  const unavailable = trainingUnavailable(profile.id);
  if (unavailable) return unavailable;
  const discipline = parseDiscipline(formData.get("discipline"));
  if (discipline === undefined)
    return formError(
      "Pick a discipline (run, ride, or swim), or leave it blank."
    );
  const unit = capturedDistanceUnit(formData, login.id);
  const out = createEndurancePlanCore(profile.id, {
    kind: String(formData.get("kind") ?? ""),
    eventName: String(formData.get("event_name") ?? ""),
    discipline,
    eventDate: String(formData.get("event_date") ?? "").trim(),
    targetDistanceKm: parseDistanceKm(
      String(formData.get("target_distance") ?? ""),
      unit
    ),
    targetTimeSec: parseTargetTimeSec(
      String(formData.get("target_time") ?? "")
    ),
    notes: String(formData.get("notes") ?? ""),
  });
  if (out.kind === "duplicate")
    return formError(
      `You already have an active ${discipline} plan. Complete or abandon it first.`
    );
  if (out.kind !== "ok") return formError(TARGET_PAIR_ERROR);
  revalidateEndurance();
  return formOk();
}

// Edit an existing plan in place. Sends a PATCH (#2573): a field the submitted form does
// not CARRY is absent from the patch and left exactly as stored, so this action is only
// ever responsible for what its caller actually edits. `has()` — not a `?? ""` fallback —
// is the test, so a control that is present but blank still means "clear this", while a
// control that does not exist means nothing at all. `notes` is the field that made this
// necessary: no surface has ever carried it, and the old whole-row write turned that
// silence into `notes = null` on every save.
export async function updateEndurancePlan(
  formData: FormData
): Promise<FormResult> {
  const { profile, login } = await requireWriteAccess();
  const unavailable = trainingUnavailable(profile.id);
  if (unavailable) return unavailable;
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return formError("Invalid plan.");
  const discipline = parseDiscipline(formData.get("discipline"));
  if (discipline === undefined)
    return formError(
      "Pick a discipline (run, ride, or swim), or leave it blank."
    );
  const unit = capturedDistanceUnit(formData, login.id);
  // Discipline is validated above and always named — it is what the duplicate check reads.
  const patch: EndurancePlanPatch = { discipline };
  if (formData.has("kind")) patch.kind = String(formData.get("kind"));
  if (formData.has("event_name"))
    patch.eventName = String(formData.get("event_name"));
  if (formData.has("event_date"))
    patch.eventDate = String(formData.get("event_date")).trim();
  if (formData.has("target_distance"))
    patch.targetDistanceKm = parseDistanceKm(
      String(formData.get("target_distance")),
      unit
    );
  if (formData.has("target_time"))
    patch.targetTimeSec = parseTargetTimeSec(
      String(formData.get("target_time"))
    );
  if (formData.has("notes")) patch.notes = String(formData.get("notes"));
  const out = updateEndurancePlanCore(profile.id, id, patch);
  if (out.kind === "duplicate")
    return formError(`You already have another active ${discipline} plan.`);
  if (out.kind !== "ok") return formError(TARGET_PAIR_ERROR);
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
  if (status === "active") {
    const unavailable = trainingUnavailable(profile.id);
    if (unavailable) return unavailable;
  }
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

// Attach one of the event day's logged activities to the event (#3285 item 2) —
// the MANUAL link, for everything the source's "race" label does not cover. The
// core refuses a session logged on another day, so the page only ever offers the
// day's own.
export async function linkEventActivity(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const planId = Number(formData.get("id"));
  const activityId = Number(formData.get("activity_id"));
  if (!Number.isInteger(planId) || !Number.isInteger(activityId))
    return formError("Invalid link.");
  if (!linkEventActivityCore(profile.id, planId, activityId))
    return formError("That activity isn’t on the event’s day.");
  revalidateEndurance();
  return formOk();
}

export async function unlinkEventActivity(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const activityId = Number(formData.get("activity_id"));
  if (!Number.isInteger(activityId)) return formError("Invalid link.");
  if (!unlinkEventActivityCore(profile.id, activityId))
    return formError("Activity not found.");
  revalidateEndurance();
  return formOk();
}
