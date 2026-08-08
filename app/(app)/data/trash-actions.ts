"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { emptyTrash, purgeDeletedRow } from "@/lib/undo-delete-db";

// Data → Trash write boundary (issue #2013).
//
// RESTORE IS NOT HERE, deliberately. The Trash is a new SURFACE over the capture #30
// already writes, not a second restore engine: its Restore button calls the SAME
// `undoDelete` Server Action the 15-second toast calls, which calls the same
// `restoreDeletedRow` core — the one that re-inserts with new ids, reconciles captured
// external FK links whose targets have since been deleted, inverts an activity merge,
// and removes the re-import tombstone the delete wrote. A second restore path would be
// a second set of those rules to keep in sync, and they would drift.
//
// What IS new is the pair of affordances a 30-day window needs and a 15-second toast
// didn't: purge one capture now, and empty the whole trash. Both are profile-scoped
// writes gated on requireWriteAccess() — a caregiver-only login with read access to a
// profile may look at its trash but not empty it.

// Delete ONE capture for good, ahead of its expiry. Typed outcome, because "gone" is a
// real state (another tab purged it, the hourly tick swept it, it was already
// restored) and a surface must not report a purge it did not perform.
export async function purgeTrashEntry(
  undoId: number
): Promise<
  { ok: true } | { ok: false; reason: "invalid" | "gone"; message: string }
> {
  const { profile } = await requireWriteAccess();
  if (!Number.isInteger(undoId) || undoId <= 0)
    return { ok: false, reason: "invalid", message: "Nothing to delete." };

  const outcome = purgeDeletedRow(profile.id, undoId);
  if (outcome.kind === "gone")
    return {
      ok: false,
      reason: "gone",
      message: "Already gone — it expired or was restored elsewhere.",
    };
  // The row leaves the list on the next render, which is the honest feedback.
  revalidateRoute("/data");
  return { ok: true };
}

// Empty the acting profile's trash. Returns how many captures were actually purged so
// the surface can say so rather than claim a number it assumed — an empty trash and a
// trash of forty are the same tap and must not read the same afterwards.
export async function emptyTrashNow(): Promise<{ purged: number }> {
  const { profile } = await requireWriteAccess();
  const purged = emptyTrash(profile.id);
  if (purged > 0) revalidateRoute("/data");
  return { purged };
}
