"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today, writeTx } from "@/lib/db";
import { canonicalFoodGroup, isValidFoodGroup } from "@/lib/food-groups";
import { isFoodSlot, type FoodSlot } from "@/lib/food-slot";
import {
  deleteFoodLogEventCore,
  logFoodServingCore,
  undoFoodServingCore,
  updateFoodLogEventCore,
  type FoodEventPlacement,
} from "@/lib/food-log-write";
import {
  acceptEatenAt,
  parseEatingTimeChoice,
  resolveEatingTimeChoice,
} from "@/lib/food-eating-time";
import { now as clockNow } from "@/lib/clock";
import { utcInstant, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { deleteFrequencyTargetRow } from "@/lib/frequency-target-delete";
import {
  addProteinGramsCore,
  undoProteinGramsCore,
} from "@/lib/protein-log-write";
import { formError, formOk, type FormResult } from "@/lib/types";

// Log/undo answer with the group's AUTHORITATIVE post-write daily total (issue #748
// item 2) so the one-tap bar reconciles its optimistic count with the server instead of
// trusting a local increment — a failed write (expired session, revoked grant) rolls the
// count back rather than leaving a phantom serving.
export type FoodLogResult =
  | {
      ok: true;
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    }
  | { ok: false; error: string };

// The largest sane weekly serving target — mirrors the protocol practice clamp so a
// fat-fingered "70" can't create a permanently-behind habit.
const MAX_PER_WEEK = 21;

// Server write-path for the food-group serving log (issue #579). One-tap logging: a day
// keeps ONE food_log row per (profile, date, group_key) whose `servings` count the bar
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
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  // The eating-time statement (#2053), when the user made one. The form carries the
  // CHOICE ("now" or an absolute local hour), never a client instant: the server resolves
  // it against its own clock and the profile's timezone, so a page that has been open for
  // an hour cannot stamp a stale "now" and no browser has to convert a profile-local hour
  // with its own locale. An absent or unusable choice records NO eating time — the
  // validate-never-drop rule: the serving always lands, the statement is what is lost.
  const choice = parseEatingTimeChoice(formData.get("eaten_at"));
  const eatenAt = choice
    ? acceptEatenAt(
        resolveEatingTimeChoice(choice, clockNow(), getTimezone(profile.id)),
        getTimezone(profile.id),
        fields.date,
        clockNow()
      )
    : null;
  const outcome = logFoodServingCore(
    profile.id,
    fields.group,
    fields.date,
    undefined,
    fields.mealSlot,
    // 'stated' for both shapes: "now" and "13:00" are equally a human answering the
    // question. 'tap' belongs to the Telegram button, whose declared contract IS "now".
    eatenAt ? { eatenAt: utcInstant(eatenAt), source: "stated" } : undefined
  );
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return {
    ok: true,
    servings: outcome.servings,
    ...(outcome.mealSlot ? { mealSlot: outcome.mealSlot } : {}),
    ...(outcome.mealServings != null
      ? { mealServings: outcome.mealServings }
      : {}),
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
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  const outcome = undoFoodServingCore(
    profile.id,
    fields.group,
    fields.date,
    fields.mealSlot
  );
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return {
    ok: true,
    servings: outcome.servings,
    ...(outcome.mealSlot ? { mealSlot: outcome.mealSlot } : {}),
    ...(outcome.mealServings != null
      ? { mealServings: outcome.mealServings }
      : {}),
  };
}

// The correction's answer (issue #1934): the placement the serving LEFT and the one it
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
// The `eaten_at` field has three wire values (#2227): absent/empty = unchanged, "none"
// = clear (back to the honest "nobody said"), "HH:MM" = state that local wall time on
// the submitted day. `acceptEatenAt`'s POSTURE INVERTS here relative to the log path,
// deliberately: at log time an unusable instant costs the statement and never the
// serving, but in a correction the statement IS the whole submission, so a refused
// instant is an error the user sees — never a silent clear.
export async function updateFoodLogEvent(
  formData: FormData
): Promise<FoodEventEditResult> {
  const { profile } = await requireWriteAccess();
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
  const rawEatenAt = String(formData.get("eaten_at") ?? "").trim();
  if (rawEatenAt === "none") {
    patch.eatenAt = null;
  } else if (rawEatenAt) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rawEatenAt))
      return formError("Enter a valid time.");
    // A wall time is only meaningful ON a day; the sheet always submits its day
    // alongside. Resolved in the profile's timezone against the SUBMITTED day, then
    // gated — the same acceptEatenAt every eaten_at write passes, with the inverted
    // consequence described above (the core re-checks against the final date too).
    if (!patch.date) return formError("Enter a valid date.");
    const tz = getTimezone(profile.id);
    const instant = zonedWallTimeToUtc(tz, patch.date, rawEatenAt);
    const accepted =
      instant && acceptEatenAt(instant, tz, patch.date, clockNow());
    if (!accepted) return formError("That time isn't on the selected day.");
    patch.eatenAt = accepted;
  }

  const outcome = updateFoodLogEventCore(profile.id, eventId, patch);
  if (outcome.kind === "not-found")
    return formError("That serving is no longer available.");
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  if (outcome.kind === "invalid-date") return formError("Enter a valid date.");
  if (outcome.kind === "invalid-eaten-at")
    return formError("That time isn't on the selected day.");
  if (outcome.kind === "not-correctable")
    return formError("Protein logs are corrected from the protein total.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
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
// the newest tap in the window by `logged_at`; since #1934 a corrected serving keeps its
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
  const { profile } = await requireWriteAccess();
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0)
    return formError("That serving is no longer available.");

  const outcome = deleteFoodLogEventCore(profile.id, eventId);
  if (outcome.kind === "not-found")
    return formError("That serving is no longer available.");
  if (outcome.kind === "not-deletable")
    return formError("Protein logs are removed from the protein total.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
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

// Add N grams of protein on a day (default today). Upserts the day's protein_log row,
// summing the grams, and records the amount as the last-used preset. The write is the
// auth-blind lib core (addProteinGramsCore); this action owns the auth gate + validation
// + revalidation and returns the day's new total for optimistic reconciliation.
export async function addProteinGrams(
  formData: FormData
): Promise<ProteinLogResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseProteinFields(formData, profile.id);
  if (!fields) return formError("Enter a protein amount in grams.");
  const outcome = addProteinGramsCore(profile.id, fields.date, fields.grams);
  if (outcome.kind === "invalid")
    return formError("Enter a protein amount between 1 and 300 grams.");
  revalidatePath("/nutrition");
  revalidatePath("/");
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
  revalidatePath("/nutrition");
  revalidatePath("/");
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
  revalidatePath("/nutrition");
  revalidatePath("/");
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
  revalidatePath("/nutrition");
  revalidatePath("/");
  return formOk();
}
