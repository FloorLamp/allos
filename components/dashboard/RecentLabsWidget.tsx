import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { MedicalValue } from "@/components/ui";
import { recentLabStatus, type RecentLabRow } from "@/lib/recent-labs";
import { formatCompactAge } from "@/lib/format-date";
import type { FlagTone } from "@/lib/reference-range";

// Tone → text color for the status label (the visible non-color channel each
// flagged row carries next to its colored value — WCAG 1.4.1, issue #1220).
function statusClass(tone: FlagTone): string {
  switch (tone) {
    case "bad":
      return "text-rose-600 dark:text-rose-400";
    case "warn":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-slate-500 dark:text-slate-400";
  }
}

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
            const status = recentLabStatus(r.flag);
            return (
              <li key={r.name} className="flex items-center gap-3">
                <Link
                  href={r.href}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
                >
                  {r.name}
                </Link>
                <span className="shrink-0 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">
                  <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
                  {status && (
                    <span
                      data-testid="recent-lab-status"
                      className={`ml-1 text-xs font-medium ${statusClass(status.tone)}`}
                    >
                      · {status.label}
                    </span>
                  )}
                </span>
                <span
                  data-testid="recent-lab-date"
                  data-stale={r.stale ? "true" : undefined}
                  title={
                    r.stale
                      ? "Older than a year — not a recent result"
                      : undefined
                  }
                  className={`w-12 shrink-0 whitespace-nowrap text-right text-xs sm:w-14 ${
                    r.stale
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
