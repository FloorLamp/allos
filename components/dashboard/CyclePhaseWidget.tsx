import { IconDroplet } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import {
  CYCLE_PHASE_LABELS,
  FORECAST_CONFIDENCE_LABELS,
  type CycleForecast,
  type CyclePhase,
} from "@/lib/cycle";

// Dashboard "Cycle phase" tile (issue #1221): "Cycle day N · <phase>" — a thin FORMATTER
// over cycleDayOnDate + cyclePhaseOnDate (lib/cycle.ts, #221), the SAME derivations the
// /medical/cycles surface reads. The PHASE stays retrospective (the luteal phase resolves
// once the next period is logged).
//
// Since #1679 the tile also shows the projected next-period WINDOW when the history can
// carry one — the same forecastNextPeriod result the Cycle surface formats, passed in as
// data so the two can never disagree. Always a window with its confidence tier, never a
// bare date; absent entirely when the forecast is insufficient or suspended, because a
// dashboard tile is the worst place to explain why there is nothing to say.
//
// Relevance-gated in the registry on the SAME `cycle` bit as the nav entry; self-hides
// when no phase is derivable.
export default function CyclePhaseWidget({
  day,
  phase,
  forecast,
}: {
  day: number;
  phase: CyclePhase;
  forecast?: CycleForecast | null;
}) {
  const projected = forecast?.kind === "forecast" ? forecast : null;
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
          {projected ? (
            <div
              className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
              data-testid="cycle-phase-forecast"
            >
              Next period {projected.windowStart} – {projected.windowEnd} ·{" "}
              {FORECAST_CONFIDENCE_LABELS[projected.confidence]}
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Derived from your logged periods.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
