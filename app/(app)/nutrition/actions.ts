"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today, writeTx } from "@/lib/db";
import { canonicalFoodGroup, isValidFoodGroup } from "@/lib/food-groups";
import { logFoodServingCore, undoFoodServingCore } from "@/lib/food-log-write";
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
  { ok: true; servings: number } | { ok: false; error: string };

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
export async function logFoodServing(
  formData: FormData
): Promise<FoodLogResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  const outcome = logFoodServingCore(profile.id, fields.group, fields.date);
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return { ok: true, servings: outcome.servings };
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
  const outcome = undoFoodServingCore(profile.id, fields.group, fields.date);
  if (outcome.kind === "unknown-group") return formError("Unknown food group.");
  revalidatePath("/nutrition");
  revalidatePath("/trends");
  revalidatePath("/");
  return { ok: true, servings: outcome.servings };
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
  // Null any referencing protocol's link FIRST (the row-ops side-state rule — a live
  // protocols.frequency_target_id FK would block the delete), THEN remove the target.
  // One IMMEDIATE transaction (#468, #748 item 5) so the two statements can't half-apply
  // and strand a protocol pointing at a deleted target.
  writeTx(() => {
    db.prepare(
      `UPDATE protocols SET frequency_target_id = NULL, owns_frequency_target = 0
        WHERE profile_id = ? AND frequency_target_id = ?`
    ).run(profile.id, id);
    db.prepare(
      `DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?`
    ).run(id, profile.id);
  });
  revalidatePath("/nutrition");
  revalidatePath("/");
  return formOk();
}
