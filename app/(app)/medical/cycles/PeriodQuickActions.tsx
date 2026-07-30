"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import type { CycleControlState } from "@/lib/cycle-plausibility";
import {
  startPeriodAction,
  endPeriodAction,
  reopenPeriodAction,
} from "./actions";

// One-tap period logging (issue #714 item 4), acting on today for the active profile.
// Answers from the action's typed result — never an unconditional confirm.
//
// NOT a binary toggle on "is a period open" (#1681 bug 2). A period ending and the next
// one starting are ~2–3 weeks apart, so offering "Period started today" the instant a
// period ends invited a tap that minted a back-to-back period and corrupted the
// start-to-start cycle lengths. With no period open the control shows the derived cycle
// state instead, and the start action returns only once a plausible gap has elapsed. The
// dated form below owns the unusual case.
//
// The offer conditions are DECIDED on the server (lib/cycle-plausibility.cycleControlState)
// and arrive here as data — this component computes nothing, so the button it shows and
// the write the action allows can never disagree.
export default function PeriodQuickActions({
  state,
}: {
  state: CycleControlState;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    okMsg: string
  ) {
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
        setError(result.error ?? "Couldn't update the period.");
        // A refusal means this page was out of date about what's recorded — re-render
        // into the state that actually holds rather than leaving a wrong control up.
        router.refresh();
        return;
      }
      toast(okMsg);
      router.refresh();
    });
  }

  const open = state.openPeriodId != null;

  return (
    <div className="space-y-2" data-testid="period-quick-actions">
      {open ? (
        <button
          type="button"
          className="btn w-full"
          disabled={pending}
          data-testid="period-ended-button"
          onClick={() => run(endPeriodAction, "Period ended")}
        >
          {pending ? "Saving…" : "Period ended today"}
        </button>
      ) : (
        <>
          {state.stateLine && (
            <div
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
              data-testid="cycle-state-line"
            >
              {state.stateLine}
            </div>
          )}
          {state.canStart && (
            <button
              type="button"
              className="btn w-full"
              disabled={pending}
              data-testid="period-started-button"
              onClick={() => run(startPeriodAction, "Period started")}
            >
              {pending ? "Saving…" : "Period started today"}
            </button>
          )}
          {state.canReopen && (
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={pending}
              data-testid="period-reopen-button"
              onClick={() => run(reopenPeriodAction, "Period reopened")}
            >
              {pending ? "Saving…" : "Still bleeding"}
            </button>
          )}
          {!state.canStart && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {state.canReopen
                ? "Ended it too early? Reopen it above, or add a period with dates below."
                : "Starting a period is a few weeks away — add one with dates below if you need to."}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
