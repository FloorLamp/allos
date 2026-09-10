"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import {
  useClaimToastKey,
  useDismissToast,
  useToast,
  useToastProfileScopeGetter,
} from "@/components/Toast";
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
  profileId?: number;
  profileToken?: number;
  owner?: symbol;
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
          profileId: announcement.profileId,
          profileToken: announcement.profileToken,
          owner: announcement.owner,
          onlyIfOwner: announcement.owner != null,
        });
        return;
      }
      toast(plan.message, {
        tone: plan.tone,
        duration: plan.duration,
        key: announcement.key,
        profileId: announcement.profileId,
        profileToken: announcement.profileToken,
        owner: announcement.owner,
        onlyIfOwner: announcement.owner != null,
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
              if (offer.isCurrent && !offer.isCurrent()) return;
              // A keyed cumulative lifecycle stays in ONE snackbar slot all the
              // way through its inverse. On phones, posting this result keyless
              // would put it at the head of the one-at-a-time queue and leave a
              // subsequent keyed write waiting invisibly behind it (#3611).
              // Reusing the key also cancels the action click's in-flight exit and
              // restarts the slot timer; consumers without a key keep the original
              // append-only behavior.
              if (outcome.ok)
                toast(offer.undoneMessage, {
                  key: announcement.key,
                  profileId: announcement.profileId,
                  profileToken: announcement.profileToken,
                  owner: announcement.owner,
                  onlyIfOwner: announcement.owner != null,
                });
              else
                toast(undoRefusalText(outcome.reason), {
                  tone: "error",
                  key: announcement.key,
                  profileId: announcement.profileId,
                  profileToken: announcement.profileToken,
                  owner: announcement.owner,
                  onlyIfOwner: announcement.owner != null,
                });
            })();
          },
        },
      });
    },
    [toast]
  );
}

// THE KEYED RECEIPT (#5738). A receipt for a write outlives the tap that made it and
// must not outlive its subject. Four things have to hold at once, and `Toast` already
// holds each of them separately:
//
//   one slot     — `key`, so a second tap on the same target upgrades in place
//   one owner    — `owner`/`onlyIfOwner`, so an older tap's inverse finishing late
//                  cannot overwrite the receipt a newer tap has already posted
//   one subject  — the profile stamp, so switching profiles clears it
//   one lifetime — `dismissKey` on unmount, so a receipt cannot outlive its surface
//
// Assembling those four is what two surfaces did independently, in two vocabularies:
// a mount ref plus a generation counter plus a claimed-owner map on
// `SubstanceUnitControl`, an epoch map plus a lifecycle reservation on `FoodLogBar`.
// This is that assembly written once. `useWritePipeline` announces through it
// (`receiptKey`) and `SubstanceUnitControl` opens one per tap; the food bar's epoch
// protocol is the third spelling and is retired by #3728.
export interface KeyedReceipt {
  // The slot this receipt occupies. The caller names it, because only the caller knows
  // what "the same target" means — an event id for a substance unit, a day/slot
  // coordinate for a serving.
  readonly key: string;
  readonly message: string;
  readonly tone?: "success" | "error";
  // Same contract as `UndoAnnouncement.undo`: absent/null is a written "no undo". An
  // offer that does not carry its own `isCurrent` gets the session's.
  readonly undo?: UndoOffer | null;
}

// One interaction's claim on the receipt channel, opened at the moment the person acted
// and answered from what is true when the write comes back.
export interface ReceiptSession {
  // The acting profile this session opened under, or undefined outside any profile
  // scope. Callers that address a different SUBJECT (the quick-log sheet writing for
  // someone else) still key by their own subject; this is who was acting.
  readonly profileId: number | undefined;
  // Still the same mount, the same subject, and the same profile scope. Callers use it
  // for their own late writes too — a `setState` after an unmount or a profile switch
  // is the same mistake as a receipt after one.
  isCurrent: () => boolean;
  // Claims the slot and publishes. A session that is no longer current says nothing:
  // announcing is the last step of an interaction that has already been superseded.
  announce: (receipt: KeyedReceipt) => void;
}

// `subject` is what this surface's receipts are ABOUT — a substance for a person on a
// day. Changing it ends every session opened under the old one and dismisses its
// receipts, because a control re-pointed at a new subject is not the surface that
// earned them.
export function useKeyedReceipt(subject?: string): () => ReceiptSession {
  const announceUndoable = useUndoableAction();
  const claimKey = useClaimToastKey();
  const getProfileScope = useToastProfileScopeGetter();
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const ownersRef = useRef(new Map<string, symbol>());
  // The dismisser is read at UNMOUNT and never during a session's life, so it is kept
  // current in a ref rather than depended on: what ends a session is the subject
  // changing or the surface going away, and listing a provider callback below would end
  // every live session the moment a host handed back a new function identity.
  const dismissKey = useDismissToast();
  const dismissKeyRef = useRef(dismissKey);
  useLayoutEffect(() => {
    dismissKeyRef.current = dismissKey;
  }, [dismissKey]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    const owners = ownersRef.current;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      for (const [key, owner] of owners) dismissKeyRef.current(key, owner);
      owners.clear();
    };
  }, [subject]);

  return useCallback(() => {
    const generation = generationRef.current;
    const scope = getProfileScope();
    const isCurrent = () => {
      if (!mountedRef.current || generationRef.current !== generation)
        return false;
      if (!scope) return true;
      const now = getProfileScope();
      return now?.profileId === scope.profileId && now.token === scope.token;
    };
    return {
      profileId: scope?.profileId,
      isCurrent,
      announce: (receipt: KeyedReceipt) => {
        if (!isCurrent()) return;
        // One owner per slot per session, so this session's own follow-ups — the undo
        // outcome riding the same key — keep publishing while a LATER session's claim
        // shuts them out.
        const owners = ownersRef.current;
        const owner = owners.get(receipt.key) ?? Symbol(receipt.key);
        owners.set(receipt.key, owner);
        claimKey(receipt.key, owner);
        const offer = receipt.undo ?? null;
        announceUndoable({
          message: receipt.message,
          tone: receipt.tone,
          key: receipt.key,
          profileId: scope?.profileId,
          profileToken: scope?.token,
          owner,
          undo: offer && { ...offer, isCurrent: offer.isCurrent ?? isCurrent },
        });
      },
    };
  }, [announceUndoable, claimKey, getProfileScope]);
}
