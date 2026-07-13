"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { isValidFoodGroup } from "@/lib/food-groups";
import { logFoodServingCore } from "@/lib/food-log-write";
import { formError, formOk, type FormResult } from "@/lib/types";

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
): { group: string; date: string } | null {
  const group = String(formData.get("group_key") ?? "").trim();
  if (!group || !isValidFoodGroup(group)) return null;
  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today(profileId);
  return { group, date };
}

// Log one serving of a food group on a day (default today). Upserts the day's row,
// incrementing its servings — so tapping twice records two servings in one row. The
// write itself is the auth-blind lib core (shared with the Telegram button handler,
// #682); this action owns the auth gate + validation + revalidation.
export async function logFoodServing(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  const outcome = logFoodServingCore(profile.id, fields.group, fields.date);
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return formOk();
}

// Undo one serving (decrement); removes the row when it would hit zero, so a fully
// undone group leaves no stray row. A no-op if nothing is logged for that group/day.
export async function undoFoodServing(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  db.prepare(
    `UPDATE food_log SET servings = servings - 1
      WHERE profile_id = ? AND date = ? AND group_key = ?`
  ).run(profile.id, fields.date, fields.group);
  db.prepare(
    `DELETE FROM food_log
      WHERE profile_id = ? AND date = ? AND group_key = ? AND servings <= 0`
  ).run(profile.id, fields.date, fields.group);
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return formOk();
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
  if (!group || !isValidFoodGroup(group))
    return formError("Unknown food group.");
  const perWeek = Math.min(
    MAX_PER_WEEK,
    Math.max(1, Math.round(Number(formData.get("per_week") ?? 2) || 2))
  );
  const existing = db
    .prepare(
      `SELECT id FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'food_group' AND scope_value = ?`
    )
    .get(profile.id, group) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE frequency_targets SET per_week = ? WHERE id = ? AND profile_id = ?`
    ).run(perWeek, existing.id, profile.id);
  } else {
    db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
       VALUES ('food_group', ?, ?, ?)`
    ).run(group, perWeek, profile.id);
  }
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
  db.prepare(
    `UPDATE protocols SET frequency_target_id = NULL, owns_frequency_target = 0
      WHERE profile_id = ? AND frequency_target_id = ?`
  ).run(profile.id, id);
  db.prepare(
    `DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?`
  ).run(id, profile.id);
  revalidatePath("/nutrition");
  revalidatePath("/");
  return formOk();
}
