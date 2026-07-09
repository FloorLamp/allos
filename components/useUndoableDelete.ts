"use client";

import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { undoDelete } from "@/app/(app)/undo/actions";

// How long the Undo toast stays up (ms). The holding row itself lives ~24h, but the
// toast is the only affordance, so it lingers well past the default success toast.
const UNDO_TOAST_MS = 15000;

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
  const router = useRouter();

  return async function run(
    action: (fd: FormData) => Promise<{ undoId: number | null }>,
    fd: FormData,
    opts: { deletedMessage: string }
  ): Promise<void> {
    const { undoId } = await action(fd);
    // Reflect the delete immediately (revalidatePath in the action marks the RSC
    // cache stale; refresh re-renders it).
    router.refresh();

    if (undoId == null) {
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
            const { ok } = await undoDelete(undoId);
            if (ok) {
              toast("Restored.");
              router.refresh();
            } else {
              toast("Couldn’t undo — it may have expired.", { tone: "error" });
            }
          })();
        },
      },
    });
  };
}
