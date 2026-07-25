"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { toggleBiomarkerSaved, moveSavedItem } from "@/lib/queries";
import { toggleItemSaved } from "@/lib/queries/saved";
import { isSavedKind, savedRefFromSeriesKey } from "@/lib/saved-items";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server Actions for the unified save store (issue #1456) — the ONE ★ gesture behind
// every savable kind. This directory holds actions only (no page.tsx, so it is not a
// route): the save store spans surfaces (biomarker pages, Trends Overview, Results)
// and belongs to none of them, and if the follow-up global "Saved" page ever lands its
// page.tsx slots in beside these. Both actions are the same auth tier
// (requireWriteAccess — saves are per-profile data, so any login acting as the profile
// may save), keeping this module's gate uniform per the #319 grouping rule.

// Toggle a save. The form carries a Trends SERIES KEY ("bio:LDL Cholesterol" |
// "metric:weight") — the vocabulary every savable tile already speaks — which
// savedRefFromSeriesKey resolves to a (kind, key) pair. An unparseable key is a
// friendly error, never a write.
//
// Kind dispatch: `biomarker` goes through toggleBiomarkerSaved so the #482 FAMILY
// semantics (a save on any member lights the family; unsaving clears every member)
// live in exactly one place; every other kind is an exact-key toggle.
export async function toggleSavedItem(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const raw = String(formData.get("key") ?? "").trim();
  const ref = savedRefFromSeriesKey(raw);
  if (!ref || !isSavedKind(ref.kind))
    return formError("Couldn't find that item.");
  if (ref.kind === "biomarker") {
    toggleBiomarkerSaved(profile.id, ref.key);
  } else {
    toggleItemSaved(profile.id, ref.kind, ref.key);
  }
  // A biomarker save is membership on three surfaces (status card, Trends tile,
  // passport summary), so every kind revalidates the same set — cheap, and it can't
  // drift as kinds are added.
  revalidatePath("/trends");
  revalidatePath("/results");
  revalidatePath("/biomarkers/view", "page");
  revalidatePath("/");
  return formOk();
}

// Reorder one saved item within the profile's saved list — the affordance that
// replaced the retired pin toggle on Trends Overview. Ordering is presentation only
// (it never changes what is saved), and a move off either end is a no-op.
export async function moveSaved(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const ref = savedRefFromSeriesKey(String(formData.get("key") ?? "").trim());
  if (!ref || !isSavedKind(ref.kind))
    return formError("Couldn't find that item.");
  const direction = String(formData.get("dir") ?? "") === "up" ? "up" : "down";
  moveSavedItem(profile.id, ref, direction);
  revalidatePath("/trends");
  return formOk();
}
