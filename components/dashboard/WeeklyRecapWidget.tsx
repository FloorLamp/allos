import { IconChartBar } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";
import { recapRangeLabel, type WeeklyRecap } from "@/lib/weekly-recap";
import { DEFAULT_FORMAT_PREFS, type DisplayFormatPrefs } from "@/lib/format-date";

// Weekly recap (NEW, issue #32, fitness). A quiet, factual summary of the last
// seven days — workouts + volume, PRs, adherence, a robust weight trend, and streak
// status — computed rule-based (no AI) in lib/weekly-recap. Off by default; when the
// week had nothing to report it shows a gentle nudge rather than an empty card.
export default function WeeklyRecapWidget({
  recap,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  recap: WeeklyRecap;
  formatPrefs?: DisplayFormatPrefs;
}) {
  return (
    <div className="card" data-testid="weekly-recap">
      <WidgetHeader title="Weekly recap" href="/timeline" />
      {recap.isEmpty || recap.lines.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing logged in the last seven days — log a workout or a weigh-in to
          start your recap.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <IconChartBar className="h-4 w-4 text-brand-500" />
            <span data-testid="weekly-recap-range">
              {recapRangeLabel(recap.start, recap.end, formatPrefs)}
            </span>
          </div>
          <dl className="space-y-2">
            {recap.lines.map((l) => (
              <div
                key={l.key}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <dt className="text-slate-500 dark:text-slate-400">
                  {l.label}
                </dt>
                <dd className="min-w-0 text-right">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {l.value}
                  </span>
                  {l.delta && (
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      {l.delta}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
