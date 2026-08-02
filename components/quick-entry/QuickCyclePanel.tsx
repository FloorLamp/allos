"use client";

import Link from "next/link";
import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import type { CycleControlState } from "@/lib/cycle-plausibility";

// The quick-log sheet's period panel (issue #1892) — the THIRD renderer of the one
// cycle offer state, after the Cycle page control and the dashboard phase widget.
//
// It holds no logic. The state was resolved on the server on open
// (`loadQuickEntry("cycle")` → `cycleControlState`), and the button below is the same
// shared <PeriodOfferButton> the other two surfaces render, so the three can never
// disagree about which verb is on offer. Gathering on OPEN rather than at layout time
// is what makes that verb current: a period started on another device between page
// load and opening the sheet changes what this panel offers.
//
// Zero prediction, by construction: it shows the derived state line the Cycle page
// shows (already-happened, never a projection) and one button. When no write is
// plausible — the days between the reopen window closing and a new period becoming
// plausible — there is no button, and the panel says where the exceptions live.
export default function QuickCyclePanel({
  state,
  onDone,
}: {
  state: CycleControlState;
  onDone: () => void;
}) {
  const open = state.openPeriodId != null;
  return (
    <div className="space-y-3 py-2" data-testid="quick-cycle-panel">
      <div className="text-sm text-slate-600 dark:text-slate-300">
        {state.stateLine ??
          "No periods logged yet — recording day 1 is what the cycle day and phase are derived from."}
      </div>
      {open && state.openPeriodStart && (
        <div
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="quick-cycle-open-since"
        >
          Period open since {state.openPeriodStart}.
        </div>
      )}
      <PeriodOfferButton
        state={state}
        surface="sheet"
        variant="compact"
        onDone={onDone}
      />
      {!open && !state.canStart && !state.canReopen && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Starting a period is a few weeks away. Add one with dates on the{" "}
          <Link
            href="/medical/cycles"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            Cycle page
          </Link>{" "}
          if you need to.
        </p>
      )}
    </div>
  );
}
