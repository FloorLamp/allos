import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { MedicalValue } from "@/components/ui";
import { type RecentLabRow } from "@/lib/recent-labs";
import { formatCompactAge } from "@/lib/format-date";

// One latest lab/biomarker reading, flattened for display by the page. The shape
// and its selection policy live in lib/recent-labs (issue #313); re-exported here
// so existing import sites (the dashboard page) stay unchanged.
export type { RecentLabRow };

// Recent labs widget (issue #171 — medical presence). The latest reading per marker
// from the newest panels, flagged markers surfaced first so an out-of-range result
// is the headline rather than buried. Read-only; the analysis lives in Trends.
export default function RecentLabsWidget({
  rows,
  today,
}: {
  rows: RecentLabRow[];
  today: string;
}) {
  return (
    <div className="card">
      <WidgetHeader title="Recent labs" href="/results/biomarkers" />
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No recent lab results.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            // Only `due` earns the amber age label. `not-applicable` — an undatable
            // reading — states its date plainly and claims nothing (#2303).
            const stale = r.freshness === "due";
            return (
              <li key={r.name} className="flex items-center gap-3">
                <Link
                  href={r.href}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
                >
                  {r.name}
                </Link>
                <span className="shrink-0 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">
                  {/* #1220 fixed the color-only severity here, with a SECOND
                      visible label built beside the component. #2315 folds that
                      into MedicalValue itself, so one component owns "value +
                      flag + severity word" for every surface that wants it — and
                      the word is announced once rather than twice. The tone color
                      comes from MedicalValue's own flag class, the same tiers the
                      widget's local map restated. */}
                  <MedicalValue
                    value={r.value}
                    unit={r.unit}
                    flag={r.flag}
                    showFlagLabel
                  />
                </span>
                <span
                  data-testid="recent-lab-date"
                  data-stale={stale ? "true" : undefined}
                  title={
                    stale
                      ? "Older than a year — not a recent result"
                      : undefined
                  }
                  className={`w-12 shrink-0 whitespace-nowrap text-right text-xs sm:w-14 ${
                    stale
                      ? "font-medium text-amber-600 dark:text-amber-400"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {formatCompactAge(r.date, today)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
