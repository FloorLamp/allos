"use client";

import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import type { CycleControlState } from "@/lib/cycle-plausibility";

// One-tap period logging on the Cycle surface (issue #714 item 4), acting on today for
// the active profile.
//
// NOT a binary toggle on "is a period open" (#1681 bug 2). A period ending and the next
// one starting are ~2–3 weeks apart, so offering "Period started today" the instant a
// period ends invited a tap that minted a back-to-back period and corrupted the
// start-to-start cycle lengths. With no period open the control shows the derived cycle
// state instead, and the start action returns only once a plausible gap has elapsed. The
// dated form below owns the unusual case — folded behind a disclosure since #2583, which
// is why the sentences below still say "below" and are still true: what stands there now
// is the disclosure's summary, visible on every visit and one tap from the form.
//
// The offer conditions are DECIDED on the server (lib/cycle-plausibility.cycleControlState)
// and arrive here as data — this component computes nothing. Since #1892 the BUTTON is
// the shared <PeriodOfferButton>, which the dashboard phase widget and the quick-log
// sheet render too: one state, one verb, three surfaces. What stays here is the page's
// own framing — the derived state line and the "why is there no button" sentence, which
// only make sense standing next to the dated form this page also carries.
export default function PeriodQuickActions({
  state,
}: {
  state: CycleControlState;
}) {
  const open = state.openPeriodId != null;

  return (
    <div className="space-y-2" data-testid="period-quick-actions">
      {!open && state.stateLine && (
        <div
          className="text-sm font-medium text-slate-700 dark:text-slate-200"
          data-testid="cycle-state-line"
        >
          {state.stateLine}
        </div>
      )}
      <PeriodOfferButton state={state} surface="page" />
      {!open && !state.canStart && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {state.canReopen
            ? "Ended it too early? Reopen it above, or add a period with dates below."
            : "Starting a period is a few weeks away — add one with dates below if you need to."}
        </p>
      )}
    </div>
  );
}
