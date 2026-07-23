import { IconDroplet } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { CYCLE_PHASE_LABELS, type CyclePhase } from "@/lib/cycle";

// Dashboard "Cycle phase" tile (issue #1221): "Cycle day N · <phase>" — a thin
// FORMATTER over cycleDayOnDate + cyclePhaseOnDate (lib/cycle.ts, #221), the SAME
// derivations the /medical/cycles surface reads. Informational ONLY, no prediction —
// honoring the #714 tracking-not-forecasting contract (the luteal phase resolves
// retrospectively once the next period is logged). Relevance-gated in the registry on
// the SAME `cycle` bit as the nav entry; self-hides when no phase is derivable.
export default function CyclePhaseWidget({
  day,
  phase,
}: {
  day: number;
  phase: CyclePhase;
}) {
  return (
    <div className="card" data-testid="cycle-phase-widget">
      <WidgetHeader title="Cycle phase" href="/medical/cycles" />
      <div className="flex items-start gap-3">
        <IconDroplet
          className="mt-1 h-5 w-5 shrink-0 text-rose-500 dark:text-rose-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div
            className="text-lg font-semibold text-slate-800 dark:text-slate-100"
            data-testid="cycle-phase-value"
          >
            Cycle day {day} · {CYCLE_PHASE_LABELS[phase]}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Derived from your logged periods — informational only, never a
            prediction.
          </div>
        </div>
      </div>
    </div>
  );
}
