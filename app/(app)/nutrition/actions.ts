"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { isValidFoodGroup } from "@/lib/food-groups";
import { formError, formOk, type FormResult } from "@/lib/types";

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
// incrementing its servings — so tapping twice records two servings in one row.
export async function logFoodServing(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const fields = parseFields(formData, profile.id);
  if (!fields) return formError("Unknown food group.");
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (profile_id, date, group_key)
     DO UPDATE SET servings = servings + 1`
  ).run(profile.id, fields.date, fields.group);
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
