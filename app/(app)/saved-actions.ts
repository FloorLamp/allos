"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { toggleBiomarkerSaved } from "@/lib/queries";
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
  revalidateRoute("/trends");
  revalidateRoute("/results");
  revalidateRoute("/biomarkers/view", "page");
  revalidateRoute("/trends/metric/[kind]", "page");
  revalidateRoute("/");
  return formOk();
}

// Set the saved order OUTRIGHT — the ONE write behind Trends Overview's reorder
// (#1485 C). It replaced the retired `moveSaved` (a one-slot up/down step on the
// stored order): drag and the ⋯ menu's arrow fallback now move within the SAME
// client-side list and persist it whole, so the two affordances can no longer
// disagree about what "earlier" means. The step math for the arrows is the pure
// `moveInOrder`, applied in the grid — see components/SavedTilesGrid.tsx.
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
  revalidateRoute("/trends");
  return formOk();
}
