"use server";

import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "../gate-item";
import { LOGGED_VIA_FIELD, parseWebOrigin } from "@/lib/logged-via";
import { revalidateRoute } from "@/lib/revalidate";
import { db, today, writeTx } from "@/lib/db";
import { canonicalFoodGroup, isValidFoodGroup } from "@/lib/food-groups";
import { isFoodSlot, type FoodSlot } from "@/lib/food-slot";
import {
  deleteFoodLogEventCore,
  foodServingTruthCore,
  logFoodServingCore,
  undoFoodServingCore,
  updateFoodLogEventCore,
  type FoodEventPlacement,
} from "@/lib/food-log-write";
import { EATEN_AT_FUTURE_SKEW_MS, judgeEatenAt } from "@/lib/food-eating-time";
import { statedHourInstant } from "@/lib/correction-time";
import { normalizeClockTime } from "@/lib/vitals-input";
import { statedInstantOnDate } from "@/lib/stated-time";
import type { StatedTimeRefusal, StatedTimeVerdict } from "@/lib/stated-time";
import { now as clockNow } from "@/lib/clock";
import { dateStrInTz, utcInstant, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { deleteFrequencyTargetRow } from "@/lib/frequency-target-delete";
import {
  addProteinGramsCore,
  undoProteinGramsCore,
} from "@/lib/protein-daily-totals-write";
import { getFoodLimitTapNote } from "@/lib/queries/food-limit";
import { getActiveFastCached } from "@/lib/queries/fasting";
import { promptsEndOfFast } from "@/lib/fasting";
import type { FoodLimitTapNote } from "@/lib/food-limit-note";
import { formError, formOk, type FormResult } from "@/lib/types";

// Log/undo answer with the group's AUTHORITATIVE post-write daily total (issue #748
// item 2) so the one-tap bar reconciles its optimistic count with the server instead of
// trusting a local increment — a failed write (expired session, revoked grant) rolls the
// count back rather than leaving a phantom serving.
export type FoodLogResult =
  | {
      ok: true;
      // Present for an add. Its Undo binds to this exact ledger row instead of
      // authenticating by a daily count that another mutation can preserve.
      eventId?: number;
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
      // The user STATED an eating time and the gate refused it (#2296). The serving
      // landed — that posture is the whole point of the log path — but the minute did
      // not, so the tap's answer carries WHY and the bar says so. Absent whenever
      // nobody stated a time, which is the common case and nothing to report. A plain
      // string union, so the Server Action record stays serializable.
      statedTimeRefused?: StatedTimeRefusal;
      // The curated limit note this tap earned (#2377), or absent — which is the
      // overwhelmingly common answer and means there is nothing to say, never an
      // all-clear. A plain object of strings and a boolean, so the record stays
      // serializable. It is a NOTE on a successful write: the serving is already on the
      // counter, and #559's rule is that context gates order, never what can be logged.
      limitNote?: FoodLimitTapNote;
      // "End your fast?" (#2756) — a FOLLOW-UP OFFER beside a successful log, never a
      // confirm-before-write and never a gate. The serving is already on the counter by
      // the time this is resolved: dueness gates nudging, never logging. Present only
      // when a fast is active AND this serving is attributed to TODAY — a backdated
      // serving for yesterday says nothing about the fast running right now, and
      // prompting on it would invite a tap that ends a fast the user never meant to
      // touch. Declining is doing nothing, and the app never auto-ends a fast: the TAP
      // is the write. A bare `true` so the record stays serializable — the surface
      // already knows the copy, and the ID would be a stale claim by the time it is
      // tapped anyway (the end core re-derives the active fast under its own lock).
      endFastOffer?: true;
    }
  | {
      ok: false;
      error: string;
      // A guarded inverse refusal returns the current server truth so the row
      // repairs any stale optimistic snapshot instead of rolling back to it.
      servings?: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    };

export type FoodServingTruthResult =
  | {
      ok: true;
      servings: number;
      mealServings: Record<FoodSlot, number>;
    }
  | { ok: false; error: string };

// A burst's individual add responses cannot establish which numeric total is
// newest once another client may remove or correct the same group. After the
// final pending response, the browser asks once for the current day + meal
// projection and adopts that coherent snapshot. This read intentionally does
// not revalidate: its caller updates only the small counter slice it requested.
export async function readFoodServingTruth(
  formData: FormData
): Promise<FoodServingTruthResult> {
  const profileId = await gateItemProfile(formData);
  const fields = parseFields(formData, profileId);
  if (!fields) return formError("Unknown food group.");
  const truth = foodServingTruthCore(profileId, fields.group, fields.date);
  return truth ? { ok: true, ...truth } : formError("Unknown food group.");
}

// The correction sheet's phrasing for a refused statement (#2296). The sheet is the
// one food surface where the statement IS the whole submission, so this is a genuine
// error — and its own sentence, because HERE the user typed the time: the shared
// device-clock note would diagnose the wrong machine. What is shared is the REASON,
// and that is the fix: the old copy said "That time isn't on the selected day"
// whatever had gone wrong, so a time the user had put in the future sent them to
// correct a day that was already right.
const CORRECTION_TIME_ERROR: Record<StatedTimeRefusal, string> = {
  future: "That time hasn't happened yet.",
  "other-day": "That time isn't on the selected day.",
  malformed: "Enter a valid time.",
};

// The largest sane weekly serving target — mirrors the protocol practice clamp so a
// fat-fingered "70" can't create a permanently-behind habit.
const MAX_PER_WEEK = 21;

// Server write-path for the food-group serving log (issue #579). One-tap logging: a day
// keeps ONE food_daily_totals row per (profile, date, group_key) whose `servings` count the bar
// increments; undo decrements it and drops the row at zero. Both are profile-scoped
// through requireWriteAccess and idempotent-friendly (the keyed upsert). group_key is
// validated against the curated catalog so a bad slug can't land.

// Parse + validate the shared form fields (group + optional date). Returns null on a
// bad group so the caller can formError.
function parseFields(
  formData: FormData,
  profileId: number
): { group: string; date: string; mealSlot?: FoodSlot } | null {
  const group = String(formData.get("group_key") ?? "").trim();
  if (!group || !isValidFoodGroup(group)) return null;
  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today(profileId);
  const rawMealSlot = String(formData.get("meal_slot") ?? "").trim();
  if (rawMealSlot && !isFoodSlot(rawMealSlot)) return null;
  return {
    group,
    date,
    ...(rawMealSlot ? { mealSlot: rawMealSlot as FoodSlot } : {}),
  };
}

// Log one serving of a food group on a day (default today). Upserts the day's row,
// incrementing its servings — so tapping twice records two servings in one row. The
// write itself is the auth-blind lib core (shared with the Telegram button handler,
// #682); this action owns the auth gate + validation + revalidation.
export async function logFoodServing(
  formData: FormData
): Promise<FoodLogResult> {
  // The mounted bar and the record's add door stamp their originating subject as
  // `profile_id`, and `gateItemProfile` is the app's ONE reader of it (#4730): this
  // action used to hand-roll the same two branches around a `profileId` nobody posts,
  // so an add carrying a subject silently landed on the ACTING profile instead. The
  // gate reauthorizes the subject, so an in-flight add cannot be retargeted by a
  // concurrent profile switch either.
  const profileId = await gateItemProfile(formData);
  const fields = parseFields(formData, profileId);
  if (!fields) return formError("Unknown food group.");
  // The eating-time statement (#2053), when the user made one. The form carries an
  // ABSOLUTE profile-local wall time ("HH:MM") and never a client instant: the server
  // resolves it against its own clock and the profile's timezone, so no browser has to
  // convert a profile-local hour with its own locale. Since #3273 that is the ONE shape
  // this field takes — the bar's hand-rolled "now" word went with its chip group, and
  // the shared control's Now button fills a wall time the person can see instead. An
  // absent or unusable statement records NO eating time — the validate-never-drop rule:
  // the serving always lands, the statement is what is lost, and since #2296 the answer
  // SAYS SO rather than dropping it in silence.
  //
  // ONE clock read for the whole decision, and one VERDICT rather than a nullable
  // instant (#2296): "nobody stated a time" and "a time was stated and refused" are
  // different answers, and only the second is something to tell the user about. A time
  // that won't resolve at all (a wall time inside a DST gap) is a refusal too, not an
  // absence — it was stated.
  const at = clockNow();
  const tz = getTimezone(profileId);
  const stated = normalizeClockTime(String(formData.get("occurred_at") ?? ""));
  // WHICH DAY A BARE WALL TIME MEANS, and the two cases are genuinely different.
  //
  //   THE ROW'S DAY IS TODAY — THE DAY RULE, with the acceptance gate's own clock
  //   tolerance, as it has been since #3273 moved the offer client-side.
  //   `statedHourInstant` reads a wall time later than `now` as YESTERDAY's: right for
  //   a picker whose hours the server enumerated, wrong for a field the browser filled
  //   from its own clock, so the skew rides along. Measured: a 90-second skew re-dated
  //   the statement and lost it. The re-dating is what keeps the backfill guard below
  //   non-vacuous for the today case.
  //
  //   THE ROW'S DAY IS A PAST DAY — ANCHORED ON THAT DAY, by construction (#4118's
  //   past-day amendment). The form NAMES its day, the surface offered that day's own
  //   hours, and `statedInstantOnDate` enforces the (date, hhmm) pair or refuses: a
  //   wall time that does not exist there (a spring-forward gap) comes back null and is
  //   reported as malformed rather than settling silently onto a different reading.
  //   Re-dating relative to `now` here is simply wrong — "8pm" stated about last
  //   Tuesday is last Tuesday's, and the day rule would resolve it to today or
  //   yesterday and then refuse it as "not on that day", which is how the amendment's
  //   sticky-time batch would have silently lost every minute it set. This is the same
  //   split `offeredHourInstant` already makes between its `today` and `prev` levels.
  const resolved = !stated
    ? null
    : fields.date === dateStrInTz(tz, at)
      ? statedHourInstant(stated, at, tz, EATEN_AT_FUTURE_SKEW_MS)
      : statedInstantOnDate(fields.date, stated, tz);
  const judged: StatedTimeVerdict = !stated
    ? { kind: "unstated" }
    : resolved === null
      ? { kind: "refused", reason: "malformed" }
      : judgeEatenAt(resolved, tz, fields.date, at);
  // THE REFUSAL IS RIGHT; ITS REASON WAS NOT. Past the tolerance a fast clock's wall
  // time re-dates to yesterday and is refused for missing the row's day — correct to
  // refuse, and re-anchoring on the row's date instead would make the backfill guard
  // below vacuous. But "it isn't on that day" is untrue when the day is the one the
  // person is standing in, and it blames the wrong machine. Same outcome, and the
  // reason the queued path already reports for this.
  //
  // Both conditions carry weight: `aheadOfServer` separates a fast clock from an hour
  // genuinely meant as yesterday's, and the row's date being today is what makes
  // "that day" theirs — a real backfill off its day is still told so.
  const localToday = dateStrInTz(tz, at);
  const onToday = stated ? zonedWallTimeToUtc(tz, localToday, stated) : null;
  const aheadOfServer =
    onToday !== null &&
    onToday.getTime() > at.getTime() + EATEN_AT_FUTURE_SKEW_MS;
  const verdict: StatedTimeVerdict =
    judged.kind === "refused" &&
    judged.reason === "other-day" &&
    aheadOfServer &&
    fields.date === localToday
      ? { kind: "refused", reason: "future" }
      : judged;
  const outcome = logFoodServingCore(
    profileId,
    fields.group,
    fields.date,
    // The one-tap food bar renders on the Nutrition page, on the dashboard, and in the
    // quick-log sheet, all posting THIS action — so the surface rides the post.
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    undefined,
    fields.mealSlot,
    // 'stated' for both shapes: "now" and "13:00" are equally a human answering the
    // question. 'tap' belongs to the Telegram button, whose declared contract IS "now".
    verdict.kind === "accepted"
      ? { eatenAt: utcInstant(verdict.at), source: "stated" }
      : undefined
  );
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  // The core's own day bound (#4118). The picker offers today and six days back; a POST
  // that names a day it never offered — the future especially — is answered, not stored.
  if (outcome.kind === "invalid-date") return formError("Pick a valid day.");
  // The curated limit note (#2377), resolved AFTER the write for two reasons. The
  // food–drug ledger detects a co-occurrence from the day's servings, so the serving has
  // to be on the counter for it to see one; and nothing in this decision may influence
  // whether the serving lands, which is #559 held structurally rather than by review.
  // `servings - 1` is the day's count BEFORE this tap — the gate for "at most one note
  // per group per day" — because after the write the count this tap produced is
  // indistinguishable from one that was already there.
  const limitNote = getFoodLimitTapNote(
    profileId,
    fields.group,
    fields.date,
    Math.max(0, outcome.servings - 1)
  );
  // The "End your fast?" follow-up (#2756), resolved AFTER the write for exactly the
  // reasons the limit note above is: nothing in this decision may influence whether the
  // serving lands. One pure predicate over (active fast, the log's attributed day,
  // today) — `promptsEndOfFast` — so the web bar, the quick-entry overlay and a future
  // Telegram rider cannot answer the same question three ways.
  const endFastOffer = promptsEndOfFast(
    getActiveFastCached(profileId),
    fields.date,
    today(profileId)
  );
  revalidateRoute("/nutrition");
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
  return {
    ok: true,
    eventId: outcome.eventId,
    servings: outcome.servings,
    ...(outcome.mealSlot ? { mealSlot: outcome.mealSlot } : {}),
    ...(outcome.mealServings != null
      ? { mealServings: outcome.mealServings }
      : {}),
    ...(verdict.kind === "refused"
      ? { statedTimeRefused: verdict.reason }
      : {}),
    ...(limitNote ? { limitNote } : {}),
    ...(endFastOffer ? { endFastOffer: true as const } : {}),
  };
}

// Undo one serving (decrement); removes the row when it would hit zero, so a fully
// undone group leaves no stray row. A no-op if nothing is logged for that group/day.
// The UPDATE+DELETE sequence lives in the auth-blind lib core (undoFoodServingCore),
// wrapped in one IMMEDIATE transaction (#468, #748 item 5); this action owns the auth
// gate + validation + revalidation and returns the group's remaining daily total.
export async function undoFoodServing(
  formData: FormData
): Promise<FoodLogResult> {
  // A toast may survive a profile transition. When it carries its originating
  // subject, reauthorize that subject explicitly; never retarget its inverse to
  // whichever profile happens to be active when Undo is clicked (#3611). Same one
  // reader as the add beside it (#4730).
  const profileId = await gateItemProfile(formData);
  const fields = parseFields(formData, profileId);
  if (!fields) return formError("Unknown food group.");
  const rawExpected = String(formData.get("expected_servings") ?? "").trim();
  const expectedServings = rawExpected === "" ? undefined : Number(rawExpected);
  if (
    expectedServings !== undefined &&
    (!Number.isInteger(expectedServings) || expectedServings < 1)
  )
    return formError("That serving count has changed.");
  const rawEventId = String(formData.get("event_id") ?? "").trim();
  const expectedEventId = rawEventId === "" ? undefined : Number(rawEventId);
  if (
    expectedEventId !== undefined &&
    (!Number.isSafeInteger(expectedEventId) || expectedEventId < 1)
  )
    return formError("That serving has changed.");
  const outcome = undoFoodServingCore(
    profileId,
    fields.group,
    fields.date,
    fields.mealSlot,
    expectedServings,
    expectedEventId
  );
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  if (outcome.kind === "changed")
    return {
      ok: false,
      error: "That serving count has changed.",
      servings: outcome.servings,
      ...(outcome.mealSlot ? { mealSlot: outcome.mealSlot } : {}),
      ...(outcome.mealServings != null
        ? { mealServings: outcome.mealServings }
        : {}),
    };
  revalidateRoute("/nutrition");
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
  return {
    ok: true,
    servings: outcome.servings,
    ...(outcome.mealSlot ? { mealSlot: outcome.mealSlot } : {}),
    ...(outcome.mealServings != null
      ? { mealServings: outcome.mealServings }
      : {}),
  };
}

// ---- "Log my usual <window>" (issue #2380) ----

// What the one-tap usual offer answers with: the groups it ACTUALLY logged, each with
/// The correction's answer (issue #1934): the placement the serving LEFT and the one it
// LANDED in, each carrying the authoritative post-write day counter and slot tally. The
// bar sets both from these numbers rather than computing a move locally, so a corrected
// serving can never be counted in two places at once.
export type FoodEventEditResult =
  | { ok: true; from: FoodEventPlacement; to: FoodEventPlacement }
  | { ok: false; error: string };

// Correct one already-logged serving's group, day, meal window (issue #1934), and/or
// eating time (issue #2227). The surfaces where logging is a TAP got create + delete
// and never got correction, and delete-and-re-log is not equivalent — a re-log stamps
// the CURRENT instant and window. This action owns the gate + validation +
// revalidation; the ledger/counter move is the auth-blind core (updateFoodLogEventCore)
// in ONE IMMEDIATE transaction. The core's statements are id + profile_id scoped, so
// another profile's event id answers "not-found" and writes nothing.
//
// The `occurred_at` field has three wire values (#2227): absent/empty = unchanged, "none"
// = clear (back to the honest "nobody said"), "HH:MM" = state that local wall time on
// the submitted day. `judgeEatenAt`'s POSTURE INVERTS here relative to the log path,
// deliberately: at log time an unusable instant costs the statement and never the
// serving, but in a correction the statement IS the whole submission, so a refused
// instant is an error the user sees — never a silent clear. Both postures now name the
// same REASON (#2296), from the one refusal vocabulary, so the sheet can distinguish
// "that isn't on the selected day" from "your device's clock is ahead" instead of
// blaming the day for a clock.
export async function updateFoodLogEvent(
  formData: FormData
): Promise<FoodEventEditResult> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0)
    return formError("That serving is no longer available.");

  const patch: {
    groupKey?: string;
    date?: string;
    mealSlot?: FoodSlot;
    eatenAt?: Date | null;
  } = {};
  const rawGroup = String(formData.get("group_key") ?? "").trim();
  if (rawGroup) {
    if (!isValidFoodGroup(rawGroup)) return formError("Unknown food group.");
    patch.groupKey = rawGroup;
  }
  const rawDate = String(formData.get("date") ?? "").trim();
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate))
      return formError("Enter a valid date.");
    patch.date = rawDate;
  }
  const rawMealSlot = String(formData.get("meal_slot") ?? "").trim();
  if (rawMealSlot) {
    if (!isFoodSlot(rawMealSlot)) return formError("Unknown meal.");
    patch.mealSlot = rawMealSlot;
  }
  const rawEatenAt = String(formData.get("occurred_at") ?? "").trim();
  if (rawEatenAt === "none") {
    patch.eatenAt = null;
  } else if (rawEatenAt) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rawEatenAt))
      return formError("Enter a valid time.");
    // A wall time is only meaningful ON a day; the sheet always submits its day
    // alongside. Resolved in the profile's timezone against the SUBMITTED day, then
    // gated — the same judgeEatenAt every occurred_at write passes, with the inverted
    // consequence described above (the core re-checks against the final date too).
    if (!patch.date) return formError("Enter a valid date.");
    // THE SUBJECT'S ZONE, not the acting profile's (#4009 item 1). A corrected
    // eating time is a wall clock ON the subject's day, so resolving it in the
    // caregiver's timezone would land the instant on a different profile-local day
    // than the row the correction was opened from.
    const tz = getTimezone(profileId);
    const instant = zonedWallTimeToUtc(tz, patch.date, rawEatenAt);
    const verdict = instant
      ? judgeEatenAt(instant, tz, patch.date, clockNow())
      : ({ kind: "refused", reason: "malformed" } as const);
    if (verdict.kind !== "accepted")
      return formError(CORRECTION_TIME_ERROR[verdict.reason]);
    patch.eatenAt = verdict.at;
  }

  const outcome = updateFoodLogEventCore(profileId, eventId, patch);
  if (outcome.kind === "not-found")
    return formError("That serving is no longer available.");
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  if (outcome.kind === "invalid-date") return formError("Enter a valid date.");
  if (outcome.kind === "invalid-eaten-at")
    return formError(CORRECTION_TIME_ERROR[outcome.reason]);
  if (outcome.kind === "not-correctable")
    return formError("Protein logs are corrected from the protein total.");
  revalidateRoute("/nutrition");
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
  return { ok: true, from: outcome.from, to: outcome.to };
}

// The row-scoped removal's answer (issue #1963): the placement the serving VACATED,
// carrying the authoritative post-write day counter and slot tally for that coordinate.
// The bar SETS both from these numbers rather than decrementing locally, exactly as it
// does for a correction's `from`/`to`.
export type FoodEventDeleteResult =
  | { ok: true; vacated: FoodEventPlacement; undoId: number }
  | { ok: false; error: string };

// Remove ONE named logged serving (issue #1963). The bar's "−" is group-scoped and pops
// the newest tap in the window by `recorded_at`; since #1934 a corrected serving keeps its
// original tap instant, so it is not necessarily the newest thing in the window it was
// moved into and the group control could take a neighbour. The ⋯ menu already asserts a
// per-row identity — this is the removal that honours it. `undoFoodServing` is unchanged.
//
// This action owns the gate + validation + revalidation; the ledger/counter removal is
// the auth-blind core (deleteFoodLogEventCore) in ONE IMMEDIATE transaction. The core's
// statements are id + profile_id scoped, so another profile's event id answers
// "not-found" and writes nothing.
export async function deleteFoodLogEvent(
  formData: FormData
): Promise<FoodEventDeleteResult> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0)
    return formError("That serving is no longer available.");

  const outcome = deleteFoodLogEventCore(profileId, eventId);
  if (outcome.kind === "not-found")
    return formError("That serving is no longer available.");
  if (outcome.kind === "not-deletable")
    return formError("Protein logs are removed from the protein total.");
  revalidateRoute("/nutrition");
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
  return { ok: true, vacated: outcome.vacated, undoId: outcome.undoId };
}

// ---- Protein-grams quick-add (issue #824) ----

// Add/undo answer with the day's AUTHORITATIVE post-write manual-protein total so the
// quick-add reconciles its optimistic figure with the server (the food-log #748 item 2
// pattern) — a failed write rolls the number back rather than leaving a phantom entry.
export type ProteinLogResult =
  { ok: true; grams: number } | { ok: false; error: string };

// Parse the grams + optional date. Returns null on a missing/non-positive amount so the
// caller can formError. The core enforces the per-add cap; this just gates the shape.
function parseProteinFields(
  formData: FormData,
  profileId: number
): { grams: number; date: string } | null {
  const grams = Number(formData.get("grams"));
  if (!Number.isFinite(grams) || grams <= 0) return null;
  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today(profileId);
  return { grams, date };
}

// Add N grams of protein on a day (default today). Upserts the day's protein_daily_totals row,
// summing the grams, and records the amount as the last-used preset. The write is the
// auth-blind lib core (addProteinGramsCore); this action owns the auth gate + validation
// + revalidation and returns the day's new total for optimistic reconciliation.
export async function addProteinGrams(
  formData: FormData
): Promise<ProteinLogResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseProteinFields(formData, profile.id);
  if (!fields) return formError("Enter a protein amount in grams.");
  const outcome = addProteinGramsCore(
    profile.id,
    fields.date,
    fields.grams,
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")
  );
  if (outcome.kind === "invalid")
    return formError("Enter a protein amount between 1 and 300 grams.");
  if (outcome.kind === "invalid-date") return formError("Pick a valid day.");
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return { ok: true, grams: outcome.grams };
}

// Undo N grams on a day: decrement the day's row (clamped at zero, dropped at zero). A
// no-op if nothing is logged. The UPDATE+DELETE sequence lives in the auth-blind core
// (undoProteinGramsCore) wrapped in one IMMEDIATE transaction (#468); this action owns
// the auth gate + validation + revalidation and returns the day's remaining total.
export async function undoProteinGrams(
  formData: FormData
): Promise<ProteinLogResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseProteinFields(formData, profile.id);
  if (!fields) return formError("Enter a protein amount in grams.");
  const outcome = undoProteinGramsCore(profile.id, fields.date, fields.grams);
  if (outcome.kind === "invalid")
    return formError("Enter a protein amount in grams.");
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return { ok: true, grams: outcome.grams };
}

// ---- Food-habit targets (issue #580) ----

// Track a food group as a weekly habit — a food_group frequency_target ("fatty fish
// ≥N×/week"). One target per (profile, group): re-tracking updates the cadence rather
// than duplicating. Reuses the generic frequency_targets table + getFrequencyTargetProgress
// (food_group branch) so progress is the #579 weekly rollup, not a second engine. The
// suggestion→target affordance and the Weekly habits card both post here (user-initiated,
// reversible, never auto-created).
export async function trackFoodHabit(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const group = String(formData.get("group_key") ?? "").trim();
  // Persist the canonical slug (#883) so the target's scope_value matches the exact
  // group_key the food log stores and habit progress can find it.
  const slug = group ? canonicalFoodGroup(group) : null;
  if (!slug) return formError("Unknown food group.");
  const perWeek = Math.min(
    MAX_PER_WEEK,
    Math.max(1, Math.round(Number(formData.get("per_week") ?? 2) || 2))
  );
  // Upsert on the partial unique index (profile_id, scope_value) WHERE
  // scope_kind = 'food_group' (migration 038, issue #748 item 4). The old
  // SELECT-then-INSERT raced — a double-tap (or the FoodSuggestions "Track" plus the
  // card form) could interleave two INSERTs and land two targets for one group, both
  // counting independently. The atomic ON CONFLICT can't, and writeTx takes the write
  // lock up front (#468). Re-tracking still just updates the cadence.
  writeTx(() => {
    db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
       VALUES ('food_group', ?, ?, ?)
       ON CONFLICT (profile_id, scope_value) WHERE scope_kind = 'food_group'
       DO UPDATE SET per_week = excluded.per_week`
    ).run(slug, perWeek, profile.id);
  });
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return formOk();
}

// Stop tracking a food-habit target. Nulls any protocol that referenced it FIRST (the
// row-ops side-state rule — a live protocols.frequency_target_id FK would otherwise
// block the delete), then removes the target. Scoped to a food_group target so it can't
// touch a training routine target.
export async function untrackFoodHabit(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("target_id"));
  if (!id) return formError("Couldn't find that habit.");
  const target = db
    .prepare(
      `SELECT id FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'food_group'`
    )
    .get(id, profile.id) as { id: number } | undefined;
  if (!target) return formError("Couldn't find that habit.");
  // The shared delete core nulls any referencing protocol's link FIRST (the row-ops
  // side-state rule — a live protocols.frequency_target_id FK would block the delete),
  // THEN removes the target, in one IMMEDIATE transaction (#468, #748 item 5) so the two
  // statements can't half-apply and strand a protocol pointing at a deleted target.
  deleteFrequencyTargetRow(profile.id, id);
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return formOk();
}
