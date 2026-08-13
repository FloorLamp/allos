"use client";

import { useUndoableAction } from "@/components/useUndoableAction";
import { undoDelete, undoDeletes } from "@/app/(app)/undo-actions";

// The undo window used to be declared here. It is now `UNDO_TOAST_MS` in
// lib/undo-offer.ts, with the rest of the shared undo vocabulary (#2642) — one number
// instead of the four copies that had grown. Re-exported so the surfaces that wire their
// own Undo toast (the food-log bar, the symptom bar) keep importing it from wherever they
// already do.
export { UNDO_TOAST_MS } from "@/lib/undo-offer";

// Shared client wiring for an undoable delete (issue #30). Runs a delete server
// action that returns an `{ undoId }` token, then shows a toast whose "Undo" action
// calls undoDelete(token). Centralizes the pattern so every delete surface (activity
// modal, body-metrics row, biomarkers table, supplement/medication cards) behaves
// the same.
//
// Since #2642 this is an ADAPTER over `useUndoableAction`, not a second undo lifecycle:
// the toast window, the "Undo" label and the refused-undo wording come from there, so a
// delete's undo and a dose confirm's undo cannot drift apart. What stays here is what is
// specific to a delete — the `{ undoId } | { undoIds }` token shape, and the fact that a
// restore's only refusal is an expired capture.
//
// Usage:
//   const undoable = useUndoableDelete();
//   await undoable(deleteActivity, fd, { deletedMessage: "Activity deleted." });
export function useUndoableDelete() {
  const announce = useUndoableAction();

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
      announce({ message: result.error, tone: "error" });
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

    if (tokens.length === 0) {
      // Nothing was deleted (already gone) — a plain confirmation, no Undo.
      announce({ message: opts.deletedMessage });
      return;
    }

    announce({
      message: opts.deletedMessage,
      undo: {
        undoneMessage: "Restored.",
        run: async () => {
          // A single token uses the single-restore action; a batch restores every
          // dropped row (each in its own transaction) under one Undo.
          const ok =
            tokens.length === 1
              ? (await undoDelete(tokens[0])).ok
              : (await undoDeletes(tokens)).restored > 0;
          // A capture that will not restore has been swept or has passed its window —
          // the delete half has exactly one refusal, and it is that one.
          return ok ? { ok: true } : { ok: false, reason: "expired" };
        },
      },
    });
  };
}
