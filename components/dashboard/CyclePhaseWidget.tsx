import { IconDroplet } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import type { CycleControlState } from "@/lib/cycle-plausibility";
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
// ── The #1892 inversion, fixed ────────────────────────────────────────────────
// This tile used to SELF-HIDE when no phase was derivable — which is exactly the state
// of someone who has not logged day 1 yet. The moment logging mattered most, the
// dashboard showed nothing and the only path was nav → Medical → Cycles. The #714
// "tracking, not forecasting" contract explains the quiet DISPLAY; it had been
// over-applied to INPUT. Never predicting does not mean never offering a log button.
//
// So the card now also renders the ONE cycle offer — the SAME <PeriodOfferButton> the
// Cycle page control and the quick-log sheet render, over the SAME server-resolved
// `cycleControlState`. It is a second RENDERER, not a second implementation: it decides
// nothing, and the label always names the write the tap will perform ("Period started
// today" / "Period ended today" / "Still bleeding"). The button self-suppresses where a
// tap would mint an implausible period, and every write lands on lib/cycle-write.ts's
// typed refusals, so a stale dashboard tap is refused rather than double-logged.
//
// With no history at all, the card IS the offer: the self-hide became the registry's
// data-aware CTA (`dataAware` in lib/dashboard-widgets.ts). Relevance-gated in the
// registry on the SAME `cycle` bit as the nav entry, so it never reaches a profile where
// cycle tracking is irrelevant.
//
// It still never forecasts on its own: the only projection shown is the one the shared
// forecast core produced, and the CTA state projects nothing at all.
export default function CyclePhaseWidget({
  day,
  phase,
  forecast,
  control,
}: {
  // Null together, before any recorded period — the card's CTA state.
  day: number | null;
  phase: CyclePhase | null;
  forecast?: CycleForecast | null;
  // The ONE offer state, resolved once on the server. Never recomputed here.
  control: CycleControlState;
}) {
  const projected = forecast?.kind === "forecast" ? forecast : null;
  const derived = day != null && phase != null;
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
          {derived ? (
            <>
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
            </>
          ) : (
            <div
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="cycle-phase-empty"
            >
              Log your period to start tracking. The cycle day and phase are
              derived from what you record.
            </div>
          )}
        </div>
      </div>
      <div className="mt-3">
        <PeriodOfferButton state={control} surface="widget" variant="compact" />
      </div>
    </div>
  );
}
