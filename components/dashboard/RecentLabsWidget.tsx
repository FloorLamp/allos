import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { MedicalValue } from "@/components/ui";
import { RECENT_LAB_STALE_LABEL, type RecentLabRow } from "@/lib/recent-labs";
import { glanceAgeToken } from "@/lib/glance-age";

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
      <WidgetHeader title="Recent labs" href="/results/readings" />
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No recent lab results.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            // The age token both glance cards share (#2332). This card's layout holds
            // the COMPACT form — a `w-14` column takes "4y", not "4 years ago" — and
            // that is the only thing it declares; when a reading earns the amber
            // treatment, and what the hover sentence says, are the shared decision.
            // Only `due` earns it: `not-applicable`, an undatable reading, states its
            // age plainly and claims nothing (#2303).
            const age = glanceAgeToken({
              date: r.date,
              today,
              freshness: r.freshness,
              form: "compact",
              floorLabel: RECENT_LAB_STALE_LABEL,
            });
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
                  data-stale={age.stale ? "true" : undefined}
                  title={age.title ?? undefined}
                  className={`w-12 shrink-0 whitespace-nowrap text-right text-xs sm:w-14 ${age.className}`}
                >
                  {age.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
