import {
  combinedMsv,
  isCombinedEstimated,
  backgroundEquivalentMonths,
  formatMsv,
  doseFramingNote,
  type CumulativeDose,
} from "@/lib/radiation-dose";

// The calm, informational cumulative-radiation-dose card on the Imaging page (#703).
// Pure presentational: it formats the ONE pure computation (lib/radiation-dose.ts) and
// never derives numbers of its own, so the page and any future surface agree. It
// renders NOTHING when there's no dose to show (an MRI/ultrasound-only record, or no
// studies in the window). Tone is deliberately non-alarmist — a running estimate for
// context, never a "you've had too much" verdict; `pediatric` swaps in the
// age-appropriate framing the app already uses on child surfaces (#150, #489).
export default function RadiationDoseCard({
  cum,
  pediatric,
}: {
  cum: CumulativeDose;
  pediatric: boolean;
}) {
  if (!cum.hasAnyDose) return null;

  const total = combinedMsv(cum);
  const estimated = isCombinedEstimated(cum);
  const bgMonths = backgroundEquivalentMonths(cum);

  return (
    <div
      data-testid="radiation-dose-card"
      className="card border-l-4 border-l-brand-400 dark:border-l-brand-600"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Cumulative radiation dose
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          trailing {cum.windowYears} years
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span
          data-testid="radiation-dose-total"
          className="text-2xl font-bold text-brand-700 dark:text-brand-300"
        >
          {estimated ? "≈ " : ""}
          {formatMsv(total)}
        </span>
        {estimated && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            includes estimates
          </span>
        )}
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
        {cum.recordedCount > 0 && (
          <div>
            <dt className="inline text-slate-500 dark:text-slate-400">
              Recorded:{" "}
            </dt>
            <dd className="inline font-medium">
              {formatMsv(cum.recordedMsv)}{" "}
              <span className="font-normal text-slate-400">
                ({cum.recordedCount}{" "}
                {cum.recordedCount === 1 ? "study" : "studies"})
              </span>
            </dd>
          </div>
        )}
        {cum.estimatedCount > 0 && (
          <div>
            <dt className="inline text-slate-500 dark:text-slate-400">
              Estimated:{" "}
            </dt>
            <dd className="inline font-medium">
              {formatMsv(cum.estimatedMsv)}{" "}
              <span className="font-normal text-slate-400">
                ({cum.estimatedCount}{" "}
                {cum.estimatedCount === 1 ? "study" : "studies"})
              </span>
            </dd>
          </div>
        )}
      </dl>

      {bgMonths != null && bgMonths > 0 && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          For context, roughly the same as {bgMonths}{" "}
          {bgMonths === 1 ? "month" : "months"} of natural background radiation.
        </p>
      )}

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {doseFramingNote(pediatric)}
      </p>
    </div>
  );
}
