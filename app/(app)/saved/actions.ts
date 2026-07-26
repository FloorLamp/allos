"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { toggleBiomarkerSaved, moveSavedItem } from "@/lib/queries";
import { setSavedOrder, toggleItemSaved } from "@/lib/queries/saved";
import {
  isSavedKind,
  savedRefFromSeriesKey,
  type SavedRef,
} from "@/lib/saved-items";
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

// Set the saved order OUTRIGHT — the write behind the Overview tiles' drag-reorder
// (#1485 C). Same auth tier and same store as moveSaved above; the difference is
// only that a drag names a DESTINATION while an arrow names a direction, so this one
// carries the whole list.
//
// The list arrives as a JSON array of Trends SERIES KEYS ("metric:weight",
// "bio:ApoB") — the vocabulary the tiles already speak — because a saved key may
// contain any character a canonical analyte name does (spaces, commas, slashes), so
// a delimiter-joined string would be a parsing bug waiting for the first analyte
// with a comma in it. Unparseable input is a friendly error, never a partial write;
// keys naming nothing savable are dropped, and setSavedOrder itself ignores refs the
// profile has not saved (a stale client can't delete a row by omitting it).
export async function reorderSaved(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("keys") ?? ""));
  } catch {
    return formError("Couldn't read that order.");
  }
  if (!Array.isArray(raw)) return formError("Couldn't read that order.");
  const refs: SavedRef[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const ref = savedRefFromSeriesKey(entry);
    if (ref && isSavedKind(ref.kind)) refs.push(ref);
  }
  if (refs.length === 0) return formError("Couldn't read that order.");
  setSavedOrder(profile.id, refs);
  revalidatePath("/trends");
  return formOk();
}
