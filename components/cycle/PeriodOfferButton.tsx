"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import {
  cycleOffer,
  type CycleControlState,
  type CyclePeriodWrite,
} from "@/lib/cycle-plausibility";
import {
  startPeriodAction,
  endPeriodAction,
  reopenPeriodAction,
} from "@/app/(app)/medical/cycles/actions";

// THE one-tap period affordance (issue #1892), rendered by every surface that offers
// one: the Cycle page's quick actions, the dashboard phase widget, and the quick-log
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
  (fd: FormData) => Promise<{ ok: boolean; error?: string }>
> = {
  start: startPeriodAction,
  end: endPeriodAction,
  reopen: reopenPeriodAction,
};

// Confirmation copy per write. Non-judgmental and purely descriptive — the #714/#992
// sensitivity contracts apply to a toast exactly as they do to a card.
const TOASTS: Record<CyclePeriodWrite, string> = {
  start: "Period started",
  end: "Period ended",
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
// spec can address the widget's button and the sheet's button separately when both
// are on screen at once.
export type PeriodOfferSurface = "page" | "widget" | "sheet";

export default function PeriodOfferButton({
  state,
  surface,
  variant = "primary",
  onDone,
}: {
  // Server-resolved. This component adds no second opinion about it.
  state: CycleControlState;
  surface: PeriodOfferSurface;
  // The reopen affordance is a recovery, not the main event — the Cycle page renders
  // it quietly. Compact is the dashboard/sheet's smaller button.
  variant?: "primary" | "compact";
  // Called after a write that actually happened (the sheet closes itself).
  onDone?: () => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const offer = cycleOffer(state);
  if (!offer) return null;

  // Bound OUTSIDE the callback: the narrowing above is what makes them safe, and a
  // closure reading `offer` re-widens it.
  const write = offer.write;
  const action = ACTIONS[write];
  const quiet = write === "reopen";
  const className =
    variant === "compact"
      ? `${quiet ? "btn-ghost" : "btn"} btn-sm w-full`
      : `${quiet ? "btn-ghost" : "btn"} w-full`;

  function run() {
    setError(null);
    startTransition(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await action(new FormData());
      } catch {
        setError("Couldn't update the period. Try again.");
        return;
      }
      if (!result.ok) {
        // A refusal means this surface was out of date about what is recorded. The
        // action revalidated, so the control re-renders into the real state; all that
        // is left to do here is SAY what happened rather than claim a write.
        setError(result.error ?? "Couldn't update the period.");
        return;
      }
      toast(TOASTS[write]);
      onDone?.();
    });
  }

  return (
    <div className="space-y-2" data-testid={`period-offer-${surface}`}>
      <button
        type="button"
        className={className}
        disabled={pending}
        data-testid={TEST_IDS[write]}
        data-period-write={write}
        onClick={run}
      >
        {pending ? "Saving…" : offer.label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
