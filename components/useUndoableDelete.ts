"use client";

import { useToast } from "@/components/Toast";
import { undoDelete, undoDeletes } from "@/app/(app)/undo-actions";

// How long the Undo toast stays up (ms). The holding row itself lives for the admin-
// configured Trash window (30 days by default, #2013), and since that window is now
// REACHABLE — Data → Trash renders every capture until it expires — this toast is the
// convenient affordance rather than the only one. It still lingers well past the
// default success toast, because catching a mis-tap in place beats navigating to find
// it.
// Exported so a surface that wires its own Undo toast (the food-log bar, which must
// reconcile its authoritative serving counts on both halves of the round trip) offers
// the same window rather than picking a second number.
export const UNDO_TOAST_MS = 15000;

// Shared client wiring for an undoable delete (issue #30). Runs a delete server
// action that returns an `{ undoId }` token, then shows a toast whose "Undo" action
// calls undoDelete(token). Centralizes the pattern so every delete surface (activity
// modal, body-metrics row, biomarkers table, supplement/medication cards) behaves
// the same.
//
// Usage:
//   const undoable = useUndoableDelete();
//   await undoable(deleteActivity, fd, { deletedMessage: "Activity deleted." });
export function useUndoableDelete() {
  const toast = useToast();

  return async function run(
    action: (
      fd: FormData
    ) => Promise<
      | { undoId: number | null; error?: string }
      | { undoIds: number[]; error?: string }
    >,
    fd: FormData,
    opts: { deletedMessage: string }
  ): Promise<void> {
    const result = await action(fd);
    if (result.error) {
      toast(result.error, { tone: "error" });
      return;
    }
    // An action may return a single token (`undoId`, the common delete) or a batch
    // (`undoIds`, an N-way merge that deletes several rows under one toast, #1081).
    // Normalize to a token list.
    const tokens =
      "undoIds" in result
        ? result.undoIds
        : result.undoId == null
          ? []
          : [result.undoId];
    // Reflect the delete immediately (revalidatePath in the action marks the RSC
    // cache stale; refresh re-renders it).

    if (tokens.length === 0) {
      // Nothing was deleted (already gone) — a plain confirmation, no Undo.
      toast(opts.deletedMessage);
      return;
    }

    toast(opts.deletedMessage, {
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            // A single token uses the single-restore action; a batch restores every
            // dropped row (each in its own transaction) under one Undo.
            const ok =
              tokens.length === 1
                ? (await undoDelete(tokens[0])).ok
                : (await undoDeletes(tokens)).restored > 0;
            if (ok) {
              toast("Restored.");
            } else {
              toast("Couldn’t undo — it may have expired.", { tone: "error" });
            }
          })();
        },
      },
    });
  };
}
