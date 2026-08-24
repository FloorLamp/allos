"use client";

import { useCallback } from "react";
import { useToast } from "@/components/Toast";
import {
  undoRefusalText,
  undoToastPlan,
  type UndoOffer,
  type UndoOutcome,
} from "@/lib/undo-offer";

// The ONE client wiring for "act → toast → Undo" (#2642).
//
// Every surface that announces a write hands its already-rendered message here, plus an
// UndoOffer when — and only when — it holds a complete, local, server-re-derived inverse
// (see the contract in lib/undo-offer.ts). This hook owns the parts that must not vary:
// the 15s window, the "Undo" label, the fact that a refusal toast never carries an Undo,
// and the wording of a refused undo.
//
// It deliberately does NOT run the write. Rendering a typed outcome is the caller's job —
// only the caller knows whether "already-taken" is a success sentence or a refusal — and
// folding the write in here would mean either a second generic result type or a hook that
// silently confirms. `useUndoableDelete` is the delete-shaped adapter over this hook, and
// the dose confirm is the second tenant.
export interface UndoAnnouncement {
  message: string;
  tone?: "success" | "error";
  // A repeated announcement for one logical slot replaces in place. The undo
  // closure therefore upgrades with the message instead of pointing at an older
  // write after a cumulative counter moves again (#3611).
  key?: string;
  // Absent/null = no undo (a refusal, or a write with no complete local inverse).
  undo?: UndoOffer | null;
}

export function useUndoableAction(): (announcement: UndoAnnouncement) => void {
  const toast = useToast();

  return useCallback(
    (announcement: UndoAnnouncement) => {
      const offer = announcement.undo ?? null;
      const plan = undoToastPlan({
        message: announcement.message,
        tone: announcement.tone,
        hasUndo: offer != null,
      });
      if (!plan.offerUndo || !offer) {
        toast(plan.message, {
          tone: plan.tone,
          duration: plan.duration,
          key: announcement.key,
        });
        return;
      }
      toast(plan.message, {
        tone: plan.tone,
        duration: plan.duration,
        key: announcement.key,
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              let outcome: UndoOutcome;
              try {
                outcome = await offer.run();
              } catch {
                // A thrown action is a transport failure, never evidence that the
                // inverse did or did not land — say so instead of claiming either.
                outcome = { ok: false, reason: "failed" };
              }
              // A keyed cumulative lifecycle stays in ONE snackbar slot all the
              // way through its inverse. On phones, posting this result keyless
              // would put it at the head of the one-at-a-time queue and leave a
              // subsequent keyed write waiting invisibly behind it (#3611).
              // Reusing the key also cancels the action click's in-flight exit and
              // restarts the slot timer; consumers without a key keep the original
              // append-only behavior.
              if (outcome.ok)
                toast(offer.undoneMessage, { key: announcement.key });
              else
                toast(undoRefusalText(outcome.reason), {
                  tone: "error",
                  key: announcement.key,
                });
            })();
          },
        },
      });
    },
    [toast]
  );
}
