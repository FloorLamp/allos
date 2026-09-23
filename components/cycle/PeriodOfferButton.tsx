"use client";

import { useEffect, useRef, useState } from "react";
import { useUndoableAction } from "@/components/useUndoableAction";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import InlineError from "@/components/InlineError";
import {
  cycleOffer,
  type CycleControlState,
  type CyclePeriodWrite,
} from "@/lib/cycle-plausibility";
import {
  startPeriodAction,
  endPeriodAction,
  reopenPeriodAction,
  undoEndPeriodAction,
  type CycleActionResult,
  type EndPeriodResult,
} from "@/app/(app)/medical/cycles/actions";
import Button from "@/components/Button";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";

// THE one-tap period affordance (issue #1892), rendered by every surface that offers
// one: the Cycle page's quick actions, the dashboard control atom, and the quick-log
// sheet's overlay.
//
// It DECIDES NOTHING. The server resolves `cycleControlState` once
// (lib/cycle-plausibility) and hands it down as data; `cycleOffer` turns that state
// into the single write on offer and its label. So three surfaces can never disagree
// about which verb is available, and the label always names the write the tap performs
// — which is the whole reason this is a component and not three buttons.
//
// It also never confirms unconditionally. Every action answers from the typed outcome
// of its write core (lib/cycle-write.ts), which re-enforces the SAME pure predicates
// under the write lock. A stale tap — this page open since yesterday while the state
// moved on elsewhere — therefore lands on an honest refusal with the core's own
// message, never a double-log or an invented period. The refusals revalidate too, so
// the surface re-renders into the state that actually holds.
//
// Renders NOTHING when no write is plausible (days 4–9 after an end). That silence is
// deliberate: the dated form on /medical/cycles owns the exceptions.

const ACTIONS: Record<
  CyclePeriodWrite,
  (fd: FormData) => Promise<CycleActionResult | EndPeriodResult>
> = {
  start: startPeriodAction,
  end: endPeriodAction,
  reopen: reopenPeriodAction,
};

// Confirmation copy per write. Non-judgmental and purely descriptive — the #714/#992
// sensitivity contracts apply to a toast exactly as they do to a card. Ruling 1's
// grammar, `<Thing> logged · <time>` (#5663): a one-tap write is always today's, so the
// slot is the day. A reopen logs nothing new; it takes an end back, and says so.
//
// UNDO ON AN END ONLY (lib/undo-offer.ts). An end writes only `period_end`, so clearing
// it is complete, and `undoEndPeriodAction` refuses once that row has moved on. A
// reopen's inverse would need the end it cleared, which `reopenPeriodCore` does not
// return. A start's would be `deleteCycleAction`, which captures the row to Trash;
// whether that counts as a complete inverse for a one-tap log is an open owner
// question, so the start offers none for now.
const TOASTS: Record<CyclePeriodWrite, string> = {
  start: "Period start logged · today",
  end: "Period end logged · today",
  reopen: "Period reopened",
};

// Stable per-verb test ids, unchanged from the Cycle page's original control so its
// spec keeps working. Surfaces disambiguate through the wrapper's `data-testid`.
const TEST_IDS: Record<CyclePeriodWrite, string> = {
  start: "period-started-button",
  end: "period-ended-button",
  reopen: "period-reopen-button",
};

// Which surface is rendering — only ever used to build the wrapper's test id, so a
// spec can address the atom's button and the sheet's button separately when both
// are on screen at once.
export type PeriodOfferSurface = "page" | "atom" | "sheet";

export default function PeriodOfferButton({
  state,
  surface,
  onDone,
}: {
  // Server-resolved. This component adds no second opinion about it.
  state: CycleControlState;
  surface: PeriodOfferSurface;
  // Called after a write that actually happened (the sheet closes itself).
  onDone?: () => void;
}) {
  const announce = useUndoableAction();
  // The declared one-tap affordance (#2130): `startPeriodAction` is a real
  // insert guarded only server-side, so the tap runs through the shared ledger
  // for #2007's double-tap absorption — the second half of a fat-fingered tap is
  // swallowed client-side, and a deliberate repeat still lands on the core's
  // typed refusal. No optimistic value: the surface re-renders from the action's
  // revalidation (the outcome-toast feedback design).
  const ledger = useOptimisticLedger("period-lifecycle");
  const [error, setError] = useState<string | null>(null);
  // ONE SETTLE after a write that landed, as `DoseStatusControl.settleConfirm` (#5900):
  // never on a reload, a refusal or under reduced motion.
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );

  function settleConfirm() {
    if (!settlePlan.animate) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettling(false);
    }, settlePlan.ms);
  }

  const offer = cycleOffer(state);
  if (!offer) return null;

  // Bound OUTSIDE the callback: the narrowing above is what makes them safe, and a
  // closure reading `offer` re-widens it.
  const write = offer.write;
  const action = ACTIONS[write];
  // RANK (#4978 ruling 3): primary where the offer is what the surface exists for —
  // the Cycle page's quick action and the sheet's cycle body. On Home it is one row's
  // control among many, and the reopen is a recovery, so both stay secondary.
  const primary = write !== "reopen" && surface !== "atom";

  function run() {
    setError(null);
    void ledger.tap({
      write: () => action(new FormData()),
      settle: (result) => {
        if (!result.ok) {
          // A refusal means this surface was out of date about what is recorded.
          // The action revalidated, so the control re-renders into the real
          // state; all that is left to do here is SAY what happened rather than
          // claim a write. Rollback, so a corrected retry isn't held in cooldown.
          setError(result.error ?? "Couldn't update the period.");
          return { kind: "rollback" };
        }
        announce({
          message: TOASTS[write],
          undo:
            "id" in result
              ? {
                  undoneMessage: "Period end undone",
                  run: () => {
                    const fd = new FormData();
                    fd.set("id", String(result.id));
                    fd.set("end", result.end);
                    return undoEndPeriodAction(fd);
                  },
                }
              : null,
        });
        settleConfirm();
        onDone?.();
        return { kind: "keep" };
      },
      onError: () => {
        setError("Couldn't update the period. Try again.");
        return { kind: "rollback" };
      },
    });
  }

  return (
    <div
      className={`space-y-2${settling ? ` ${settlePlan.className}` : ""}`}
      data-testid={`period-offer-${surface}`}
    >
      {/* Disabled through the cooldown too, not just in flight: this control has
          no count to move, so the swallowed second tap is made visible instead of
          silently ignored (the substance-card posture; lib/one-tap.ts). The label
          stays put while in flight (#5900); `busy` adds the shared mark. */}
      <Button
        variant={primary ? "primary" : undefined}
        layout="block"
        disabled={ledger.blocked()}
        busy={ledger.pending()}
        data-testid={TEST_IDS[write]}
        data={{ "data-period-write": write }}
        onClick={run}
      >
        {offer.label}
      </Button>
      <InlineError>{error}</InlineError>
    </div>
  );
}
