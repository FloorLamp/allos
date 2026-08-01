import { EmptyState } from "@/components/ui";
import {
  FORECAST_CONFIDENCE_LABELS,
  FORECAST_MIN_CYCLES,
  type CycleForecast,
} from "@/lib/cycle";

// The next-period forecast card (issue #1679) — a pure FORMATTER over the one
// forecastNextPeriod result (#221). It computes nothing: the window, the confidence tier
// and the evidence all arrive decided, so this card and the dashboard tile can never
// disagree about what was projected.
//
// The three shapes are the three honest answers:
//   • a WINDOW with its confidence label and the evidence it rests on;
//   • "log a couple more cycles" when the history can't carry a claim — silence, with a
//     reason, rather than a fabricated date;
//   • a suspension note during a pregnancy or after menopause.
//
// A prediction is never phrased as certainty and the ovulation line is always marked as an
// estimate from history. The app-wide framing lives on /disclaimer (#1049); what this card
// carries is the DOMAIN-specific safety line — a fertile window is not contraception.
export default function CycleForecastCard({
  forecast,
}: {
  forecast: CycleForecast;
}) {
  if (forecast.kind === "suspended") {
    return (
      <section className="card space-y-2" data-testid="cycle-forecast">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Next period
        </h2>
        <p
          className="text-sm text-slate-600 dark:text-slate-300"
          data-testid="cycle-forecast-suspended"
        >
          {forecast.reason === "pregnancy"
            ? "Paused while a pregnancy is recorded — a projected period doesn't apply."
            : "Paused: your recorded reproductive status is postmenopausal."}
        </p>
      </section>
    );
  }

  if (forecast.kind === "insufficient") {
    return (
      <section className="card space-y-2" data-testid="cycle-forecast">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Next period
        </h2>
        <EmptyState
          message={`Log a couple more cycles — a projection needs at least ${FORECAST_MIN_CYCLES} completed cycles to say anything honest. ${
            forecast.cycleCount === 0
              ? "None recorded yet."
              : `${forecast.cycleCount} so far.`
          }`}
        />
      </section>
    );
  }

  const ev = forecast.evidence;
  return (
    <section className="card space-y-2" data-testid="cycle-forecast">
      <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        Next period
      </h2>
      <div
        className="text-lg font-semibold text-slate-800 dark:text-slate-100"
        data-testid="cycle-forecast-window"
      >
        {forecast.windowStart} – {forecast.windowEnd}
      </div>
      <div
        className="text-xs font-medium text-slate-600 dark:text-slate-300"
        data-testid="cycle-forecast-confidence"
      >
        {FORECAST_CONFIDENCE_LABELS[forecast.confidence]} (±
        {forecast.halfWidthDays} days around {forecast.projectedStart})
      </div>
      <p
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="cycle-forecast-evidence"
      >
        From {ev.cycleCount} completed cycles: average {ev.meanLength} days,
        spread {ev.variabilityDays} days, last period started{" "}
        {ev.lastPeriodStart}.
      </p>
      {forecast.overdue && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This cycle has already run past the projected window, so the estimate
          is less certain — it has been widened rather than moved.
        </p>
      )}
      {forecast.ovulationEstimate && (
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="cycle-forecast-ovulation"
        >
          Ovulation estimated around{" "}
          {forecast.ovulationEstimate.estimatedDate} (
          {forecast.ovulationEstimate.windowStart} –{" "}
          {forecast.ovulationEstimate.windowEnd}). Calculated from your cycle
          lengths — an estimate from history, not an observation.
        </p>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        A projection from your own recorded cycles, not a certainty — and never
        a contraceptive method.
      </p>
    </section>
  );
}
