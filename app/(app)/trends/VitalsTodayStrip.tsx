import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { timelineDayHref } from "@/lib/hrefs";
import type { TodayVitalRow } from "@/lib/vitals-day";

// The Trends → Vitals "Today" strip (issue #1466 A).
//
// Trends answered "how has this trended" and had no answer at all for "what is it
// right now" — today's readings existed only as the last point of each windowed
// chart, and the surface that DOES show the day (the Timeline day view's intraday
// panel, #1068) was unreachable from here. This is that answer: the latest reading
// of each vital on the profile's today, with its clock time, plus the link across.
//
// A pure FORMATTER — `buildTodayVitalsStrip` (lib/vitals-day.ts) picks the rows
// from series the section already queried, so no data path is added. An empty day
// yields no rows and this renders NOTHING (never an empty frame), matching how
// every intraday layer in #1068 is data-gated.
export default function VitalsTodayStrip({
  rows,
  date,
}: {
  rows: TodayVitalRow[];
  date: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="card mb-6" data-testid="vitals-today-strip">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Today
        </h3>
        <Link
          href={timelineDayHref(date)}
          data-testid="vitals-today-timeline-link"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          See today&rsquo;s timeline <IconArrowRight size={14} />
        </Link>
      </div>
      {/* Its own horizontal scroll container so a long strip can never page-widen
          on a phone (#1063). */}
      <div className="flex gap-4 overflow-x-auto pb-1">
        {rows.map((row) => (
          <div
            key={row.key}
            data-testid={`vitals-today-${row.key}`}
            className="shrink-0"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {row.label}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {row.value}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {row.unit}
              </span>
            </div>
            <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {row.time ?? "today"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
