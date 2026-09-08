"use client";

import { useLayoutEffect, useRef, useState } from "react";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useUndoableAction } from "@/components/useUndoableAction";
import {
  useClaimToastKey,
  useDismissToast,
  useToastProfileScopeGetter,
} from "@/components/Toast";
import { substanceDef } from "@/lib/substance-use";
import { LabeledVerbChip } from "@/components/OfferRow";
import { useQuickEntryRow } from "@/components/quick-entry/QuickEntryRowList";
import {
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
} from "@/app/(app)/medical/substance-use/actions";

// THE SUBSTANCE DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.substance.pieces.rowControl`: the unit tap, its undo and the #998 cap
// verdict. The record's card and the quick-log sheet's row both mount it.
//
// THE CAP LINE BELONGS TO THE CONTROL, NOT ITS HOSTS. The manifest excludes this domain
// from the offline queue for exactly one reason (#3279) — the verdict renders beside
// the button and a queued unit would leave that safety readout understating — so the
// verdict travels with the TAP, and a second tap surface cannot forget to draw it.
// `capProgress` is null for a profile that set no target, and null renders NOTHING: no
// "no cap set", no dash, no placeholder. That boundary is structural
// (docs/internals/substances.md); do not add a flag re-asking it. `cap: 0` is the other
// state and DOES render — an opted-in target of zero is a target.
//
// ONE FIELD SET AT EVERY MOUNT (#4424 class C): the sheet's row offered no undo.
// `weekCount` is optional because only the card's read knows it; undefined means
// unknown, so the tap is offered rather than disabled on a guess (undo is idempotent),
// and every write answers with the post-write count.
export default function SubstanceUnitControl({
  substance,
  weekCount,
  capProgress,
  capAttention = false,
  testIdPrefix,
  subjectProfileId,
}: {
  substance: string;
  weekCount?: number;
  capProgress: string | null;
  capAttention?: boolean;
  /** `substance` on the record's card, `quick-entry-substance` in the sheet. */
  testIdPrefix: string;
  // The quick-log sheet's chosen subject (#4932), when it is not the acting
  // profile. Posted as `profile_id` and re-gated by the action's own
  // `gateItemProfile` call.
  subjectProfileId?: number;
}) {
  const ledger = useOptimisticLedger("substance-unit");
  const stampLoggedVia = useLoggedViaStamp();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(weekCount);
  const inQuickEntryRow = useQuickEntryRow();
  const announceUndoable = useUndoableAction();
  const getToastProfileScope = useToastProfileScopeGetter();
  const claimToastKey = useClaimToastKey();
  const dismissToast = useDismissToast();
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const receiptOwnersRef = useRef(new Map<string, symbol>());

  useLayoutEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    const receiptOwners = receiptOwnersRef.current;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      for (const [key, owner] of receiptOwners) dismissToast(key, owner);
      receiptOwners.clear();
    };
  }, [dismissToast, subjectProfileId, substance]);

  async function tap(kind: "log" | "undo"): Promise<void> {
    setError(null);
    const originGeneration = generationRef.current;
    const originScope = getToastProfileScope();
    const originProfileId = subjectProfileId ?? originScope?.profileId;
    const isCurrent = () => {
      if (!mountedRef.current || generationRef.current !== originGeneration)
        return false;
      if (!originScope) return true;
      const currentScope = getToastProfileScope();
      return (
        currentScope?.profileId === originScope.profileId &&
        currentScope.token === originScope.token
      );
    };
    // #2007: additive substance taps never confirm — several a day is the use case.
    // The ledger's inert window absorbs an accidental double click; undo carries its
    // own key, so a correction straight after a log is not absorbed by it.
    await ledger.tap({
      key: kind,
      write: () => {
        const fd = stampLoggedVia(new FormData());
        fd.set("substance", substance);
        if (originProfileId != null)
          fd.set("profile_id", String(originProfileId));
        return kind === "log"
          ? logSubstanceUnitAction(fd)
          : undoSubstanceUnitAction(fd);
      },
      settle: (result) => {
        if (!isCurrent()) return { kind: "keep" };
        if (!result.ok) {
          setError(result.error);
          // Nothing was written, so the tap stays immediately retryable.
          return { kind: "rollback" };
        }
        setCount(result.weekCount);
        if (
          kind === "log" &&
          inQuickEntryRow &&
          originScope &&
          originProfileId != null &&
          "eventId" in result
        ) {
          const { eventId, date } = result;
          const key = `substance-log:${originProfileId}:${substance}:${eventId}`;
          const owner = Symbol(key);
          receiptOwnersRef.current.set(key, owner);
          claimToastKey(key, owner);
          const unit =
            substanceDef(substance).unitSingular === "drink"
              ? "Standard drink"
              : "Use";
          announceUndoable({
            message: `${unit} logged.`,
            key,
            profileId: originScope.profileId,
            profileToken: originScope.token,
            owner,
            undo: {
              undoneMessage: `${unit} undone.`,
              isCurrent,
              run: async () => {
                if (!isCurrent()) return { ok: false, reason: "changed" };
                const undoFd = new FormData();
                undoFd.set("profile_id", String(originProfileId));
                undoFd.set("substance", substance);
                undoFd.set("event_id", String(eventId));
                undoFd.set("date", date);
                const undone = await undoSubstanceUnitAction(undoFd);
                if (isCurrent() && undone.weekCount != null)
                  setCount(undone.weekCount);
                return undone.ok
                  ? { ok: true }
                  : {
                      ok: false,
                      reason:
                        undone.error === "That use has changed."
                          ? "changed"
                          : "failed",
                    };
              },
            },
          });
        }
        return { kind: "keep" };
      },
      onError: () => {
        if (isCurrent()) setError("Couldn't update that entry.");
        return { kind: "rollback" };
      },
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {inQuickEntryRow ? (
          <LabeledVerbChip
            label={
              substanceDef(substance).unitSingular === "drink"
                ? "Standard drink"
                : "Use"
            }
            verb={ledger.pending("log") ? "Logging…" : "Log"}
            tone="neutral"
            disabled={ledger.blocked("log")}
            onAct={() => void tap("log")}
            ariaLabel={substanceDef(substance).logLabel}
            testId={`${testIdPrefix}-log-${substance}`}
          />
        ) : (
          <button
            type="button"
            className="btn"
            disabled={ledger.blocked("log")}
            onClick={() => void tap("log")}
            data-testid={`${testIdPrefix}-log-${substance}`}
          >
            {ledger.pending("log")
              ? "Logging…"
              : substanceDef(substance).logLabel}
          </button>
        )}
        {!inQuickEntryRow ? (
          <button
            type="button"
            className="btn-ghost"
            disabled={ledger.blocked("undo") || count === 0}
            onClick={() => void tap("undo")}
            data-testid={`${testIdPrefix}-undo-${substance}`}
          >
            Undo today
          </button>
        ) : null}
      </div>
      {capProgress ? (
        <p
          className={`text-sm ${
            capAttention
              ? "font-medium text-amber-700 dark:text-amber-300"
              : "text-slate-500 dark:text-slate-400"
          }`}
          data-testid={`${testIdPrefix}-cap-progress-${substance}`}
        >
          {capProgress}
        </p>
      ) : null}
      <InlineError data-testid={`${testIdPrefix}-error-${substance}`}>
        {error}
      </InlineError>
    </div>
  );
}
