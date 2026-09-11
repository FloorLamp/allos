"use client";

import Link from "next/link";
import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import TtcLogControls from "@/components/cycle/TtcLogControls";
import type { QuickEntryTtc } from "@/app/(app)/quick-entry-actions";
import type { CycleControlState } from "@/lib/cycle-plausibility";
import { CYCLE_SUSPENSION_NOTES } from "@/lib/cycle";

// The quick-log sheet's period panel (issue #1892) — the THIRD renderer of the one
// cycle offer state, after the Cycle page control and dashboard control atom.
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
//
// SINCE #5810 it has a second, GATED half. `ttc` is present only when the loader found
// a declared TTC start (`getTtcStart`), so for every other profile this component
// renders exactly what it rendered before — the absence of the prop IS the gate, and
// there is no branch here that could leak it. When it is present, the SAME
// <TtcLogControls> the Cycle page mounts renders the three daily observations under the
// period offer: one component, one set of three actions, no second write path. The
// order is deliberate — the period verb stays first, because it is the row's own label
// (#1892) and the three below are what a TTC morning adds to it, not what replaces it.
export default function QuickCyclePanel({
  state,
  ttc,
  onDone,
}: {
  state: CycleControlState;
  ttc?: QuickEntryTtc;
  onDone: () => void;
}) {
  const open = state.openPeriodId != null;
  return (
    <div className="space-y-3" data-testid="quick-cycle-panel">
      {/* Three sentences, in order of what is true (#2801): the derived state line; the
          pause, when a recorded pregnancy or postmenopausal status means no cycle day
          applies; and only otherwise the "nothing logged yet" prompt, which would
          otherwise read as an instruction to a pregnant user. */}
      <div className="text-sm text-slate-600 dark:text-slate-300">
        {state.stateLine ??
          (state.suspension
            ? CYCLE_SUSPENSION_NOTES[state.suspension]
            : "No periods logged yet — recording day 1 is what the cycle day and phase are derived from.")}
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
      {/* Spread whole: the gathered payload IS the control's props, so a fourth
          reading added to the bar cannot be silently missing here. */}
      {ttc && <TtcLogControls {...ttc} />}
      {!open && !state.canStart && !state.canReopen && !state.suspension && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Starting a period is a few weeks away. Add one with dates on the{" "}
          <Link href="/medical/cycles" className="text-link">
            Cycle page
          </Link>{" "}
          if you need to.
        </p>
      )}
    </div>
  );
}
