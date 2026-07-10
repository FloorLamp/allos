"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { FrequencyScopeKind } from "@/lib/types";
import { REGION_SCOPES, GROUP_SCOPES, TYPE_SCOPES } from "@/lib/lifts";

// Allowed scope_value strings per scope_kind, used to validate input.
function isValidScope(kind: FrequencyScopeKind, value: string): boolean {
  if (kind === "region") return (REGION_SCOPES as string[]).includes(value);
  if (kind === "group") return (GROUP_SCOPES as string[]).includes(value);
  if (kind === "type")
    return (TYPE_SCOPES as readonly string[]).includes(value);
  return false;
}

export async function createFrequencyTarget(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id")) || null;
  const kind = String(formData.get("scope_kind") ?? "") as FrequencyScopeKind;
  const value = String(formData.get("scope_value") ?? "").trim();
  const perWeek = Math.max(
    1,
    Math.round(Number(formData.get("per_week") ?? 0))
  );
  if (!isValidScope(kind, value) || !Number.isFinite(perWeek)) return;

  if (id) {
    // Editing an existing routine — update it in place, including a changed scope.
    // If a *different* row already occupies the new scope, remove it first so the
    // edit merges into one row (rather than colliding / duplicating).
    db.prepare(
      "DELETE FROM frequency_targets WHERE scope_kind = ? AND scope_value = ? AND id != ? AND profile_id = ?"
    ).run(kind, value, id, profile.id);
    db.prepare(
      "UPDATE frequency_targets SET scope_kind = ?, scope_value = ?, per_week = ? WHERE id = ? AND profile_id = ?"
    ).run(kind, value, perWeek, id, profile.id);
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
        "UPDATE frequency_targets SET per_week = ? WHERE id = ? AND profile_id = ?"
      ).run(perWeek, existing.id, profile.id);
    } else {
      db.prepare(
        "INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id) VALUES (?,?,?,?)"
      ).run(kind, value, perWeek, profile.id);
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
