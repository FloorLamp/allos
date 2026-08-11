import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { timelineDayHref } from "@/lib/hrefs";
import type { TodayVitalRow } from "@/lib/vitals-day";

// The Trends → Body "Today" card (evolved from issue #1466 A).
//
// Trends answered "how has this trended" and had no answer for "what is my body
// doing right now." This is that concise answer: today's source-prioritized body
// composition plus the latest selected vital readings, with the link across to the
// Timeline day view's richer intraday panel (#1068).
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
  const desktopColumns =
    {
      1: "sm:grid-cols-1",
      2: "sm:grid-cols-2",
      3: "sm:grid-cols-3",
      4: "sm:grid-cols-4",
      5: "sm:grid-cols-5",
      6: "sm:grid-cols-6",
    }[rows.length] ?? "sm:grid-cols-6";

  return (
    <section
      className="card overflow-hidden p-0! sm:grid sm:grid-cols-[12rem_minmax(0,1fr)]"
      data-testid="vitals-today-strip"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3.5 sm:flex-col sm:items-start sm:justify-center sm:border-r sm:border-black/10 sm:px-5 sm:py-4 dark:sm:border-white/10">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            Today
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Latest readings
          </p>
        </div>
        <Link
          href={timelineDayHref(date)}
          data-testid="vitals-today-timeline-link"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
        >
          View timeline <IconArrowRight size={14} stroke={1.75} />
        </Link>
      </div>

      <dl
        className={`grid grid-cols-2 gap-px border-t border-black/10 bg-black/10 sm:border-t-0 dark:border-white/10 dark:bg-white/10 ${desktopColumns}`}
        data-testid="vitals-today-grid"
      >
        {rows.map((row, index) => (
          <div
            key={row.key}
            data-testid={`vitals-today-${row.key}`}
            className={`min-w-0 bg-white/55 px-4 py-3.5 sm:px-5 sm:py-4 dark:bg-ink-800/70 ${
              rows.length % 2 === 1 && index === rows.length - 1
                ? "col-span-2 sm:col-span-1"
                : ""
            }`}
          >
            <dt className="section-label truncate" title={row.label}>
              {row.label}
            </dt>
            <dd className="mt-1.5 flex min-w-0 items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-tight tabular-nums text-slate-900 dark:text-slate-100">
                {row.value}
              </span>
              <span className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">
                {row.unit}
              </span>
            </dd>
            <dd className="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {row.time ? `at ${row.time}` : "today"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
