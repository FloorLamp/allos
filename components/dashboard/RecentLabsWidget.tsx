import Link from "next/link";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { flagLabel, flagTone } from "@/lib/reference-range";
import type { MedicalFlag } from "@/lib/types";

// One latest lab/biomarker reading, flattened for display by the page.
export interface RecentLabRow {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string;
  href: string;
}

const BADGE_BAD =
  "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
const BADGE_WARN =
  "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
const BADGE_DEFAULT =
  "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";

// Map the shared flag tone (issue #306) onto this widget's badge classes:
// out-of-range → "bad" (rose), non-optimal → "warn" (amber), else neutral.
function flagBadge(flag: MedicalFlag): string {
  switch (flagTone(flag)) {
    case "bad":
      return BADGE_BAD;
    case "warn":
      return BADGE_WARN;
    default:
      return BADGE_DEFAULT;
  }
}

// Recent labs widget (issue #171 — medical presence). The latest reading per marker
// from the newest panels, flagged markers surfaced first so an out-of-range result
// is the headline rather than buried. Read-only; the analysis lives in Trends.
export default function RecentLabsWidget({ rows }: { rows: RecentLabRow[] }) {
  return (
    <div className="card">
      <WidgetHeader
        title="Recent labs"
        href="/biomarkers"
        linkLabel="All labs"
      />
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No recent lab results.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const flagged = r.flag != null && r.flag !== "normal";
            return (
              <li key={r.name} className="flex items-center gap-3">
                <Link
                  href={r.href}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
                >
                  {r.name}
                </Link>
                <span className="shrink-0 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">
                  {r.value ?? "—"}
                  {r.unit ? ` ${r.unit}` : ""}
                </span>
                {flagged && (
                  <span
                    className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${flagBadge(r.flag!)}`}
                  >
                    {flagLabel(r.flag!)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
