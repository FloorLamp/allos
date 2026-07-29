"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { FrequencyScopeKind } from "@/lib/types";
import { REGION_SCOPES, GROUP_SCOPES, TYPE_SCOPES } from "@/lib/lifts";
import { canonicalFoodGroup, isValidFoodGroup } from "@/lib/food-groups";

// Allowed scope_value strings per scope_kind, used to validate input.
function isValidScope(kind: FrequencyScopeKind, value: string): boolean {
  if (kind === "region") return (REGION_SCOPES as string[]).includes(value);
  if (kind === "group") return (GROUP_SCOPES as string[]).includes(value);
  if (kind === "type")
    return (TYPE_SCOPES as readonly string[]).includes(value);
  // Food-habit targets (#580): scope_value is a lib/food-groups.json slug.
  if (kind === "food_group") return isValidFoodGroup(value);
  // Mobility-habit targets (#840): scope_value is a MuscleRegion — the SAME vocabulary as
  // `region`, but counted from recovery sessions (a separate view, #482).
  if (kind === "mobility_region")
    return (REGION_SCOPES as string[]).includes(value);
  // Wellness-practice targets (#1259): scope_value is a free-text practice NAME (curated
  // starter list + free text), so any non-empty name is valid.
  if (kind === "practice") return value.length > 0;
  return false;
}

// Parse an optional weekly ceiling (#1259): a positive integer strictly greater than the
// floor makes the target a range; anything else (blank, non-numeric, ≤ floor) is no
// ceiling (NULL). Only practice targets carry one today, but the column is general.
function parsePerWeekMax(
  raw: FormDataEntryValue | null,
  floor: number
): number | null {
  const n = Math.round(Number(raw ?? 0));
  return Number.isFinite(n) && n > floor ? n : null;
}

export async function createFrequencyTarget(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id")) || null;
  const kind = String(formData.get("scope_kind") ?? "") as FrequencyScopeKind;
  let value = String(formData.get("scope_value") ?? "").trim();
  const perWeek = Math.max(
    1,
    Math.round(Number(formData.get("per_week") ?? 0))
  );
  if (!isValidScope(kind, value) || !Number.isFinite(perWeek)) return;
  // Persist the canonical food-group slug, not the raw input (#883) — downstream habit
  // progress compares scope_value exactly against the food_log group_key.
  if (kind === "food_group") {
    const slug = canonicalFoodGroup(value);
    if (!slug) return;
    value = slug;
  }
  // Optional weekly ceiling (#1259) — a range target ("3–5×/week"). NULL keeps the
  // existing single-floor semantics for every other scope.
  const perWeekMax = parsePerWeekMax(formData.get("per_week_max"), perWeek);

  if (id) {
    // Editing an existing routine — update it in place, including a changed scope.
    // If a *different* row already occupies the new scope, remove it first so the
    // edit merges into one row (rather than colliding / duplicating).
    db.prepare(
      "DELETE FROM frequency_targets WHERE scope_kind = ? AND scope_value = ? AND id != ? AND profile_id = ?"
    ).run(kind, value, id, profile.id);
    db.prepare(
      "UPDATE frequency_targets SET scope_kind = ?, scope_value = ?, per_week = ?, per_week_max = ? WHERE id = ? AND profile_id = ?"
    ).run(kind, value, perWeek, perWeekMax, id, profile.id);
  } else {
    // New entry: one target per (scope_kind, scope_value), so an existing scope
    // has its cadence updated instead of duplicated.
    const existing = db
      .prepare(
        "SELECT id FROM frequency_targets WHERE scope_kind = ? AND scope_value = ? AND profile_id = ?"
      )
      .get(kind, value, profile.id) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE frequency_targets SET per_week = ?, per_week_max = ? WHERE id = ? AND profile_id = ?"
      ).run(perWeek, perWeekMax, existing.id, profile.id);
    } else {
      db.prepare(
        "INSERT INTO frequency_targets (scope_kind, scope_value, per_week, per_week_max, profile_id) VALUES (?,?,?,?,?)"
      ).run(kind, value, perWeek, perWeekMax, profile.id);
    }
  }
  revalidatePath("/training");
  revalidatePath("/");
}

export async function deleteFrequencyTarget(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare(
    "DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidatePath("/training");
  revalidatePath("/");
}
