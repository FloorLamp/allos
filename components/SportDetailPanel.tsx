"use client";

import type { ReactNode } from "react";
import type { SportStat } from "@/lib/queries";
import { formatMinutes } from "@/lib/duration";
import { formatLongDate, formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import LineChartCard from "@/components/LineChartCard";
import { StatBox } from "@/components/StatBox";

// Per-sport detail: records grid, a duration-over-time trend, and the last few
// sessions linked to their journal entries. Sports carry only duration, so this
// is the lightweight cousin of the cardio/exercise panels.
export default function SportDetailPanel({
  stat,
  headerRight,
  showTrend = true,
  showRecent = true,
}: {
  stat: SportStat;
  // Optional control pinned to the right of the header (e.g. a close button).
  headerRight?: ReactNode;
  showTrend?: boolean;
  showRecent?: boolean;
}) {
  const todayStr = dateStrInTz(useTimezone());
  const chart = stat.trend.map((t) => ({
    date: t.date,
    value: Math.round(t.durationMin),
  }));

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {/* Below lg the panel renders inside MobileDetailPage, whose header
            already shows the name — hide the inline one there. */}
        <h2 className="font-semibold text-slate-800 max-lg:hidden dark:text-slate-100">
          {stat.sport}
        </h2>
        {headerRight}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3">
        <StatBox
          label="Longest time"
          value={
            stat.longestDurationMin > 0
              ? formatMinutes(stat.longestDurationMin)
              : "—"
          }
          sub={
            stat.longestDurationMin > 0
              ? formatLongDate(stat.longestDurationDate)
              : undefined
          }
        />
        <StatBox label="Sessions" value={String(stat.sessions)} />
        <StatBox
          label="Total time"
          value={formatMinutes(stat.totalDurationMin)}
        />
        <StatBox
          label="Last done"
          value={formatRelativeDate(stat.lastDate, todayStr)}
          sub={formatLongDate(stat.lastDate)}
          href={`/training?tab=log#activity-${stat.lastActivityId}`}
        />
      </dl>

      {showTrend && chart.some((c) => c.value > 0) && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Duration over time
          </h3>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Minutes per session
          </p>
          <LineChartCard
            data={chart}
            label="Duration"
            unit=" min"
            color="#a855f7"
            heightClass="h-40"
          />
        </div>
      )}

      {showRecent && stat.recent.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {stat.recent.length === 1
              ? "Last session"
              : `Last ${stat.recent.length} sessions`}
          </h3>
          <ul className="space-y-1 text-sm">
            {stat.recent.map((r, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-3 border-b border-black/5 pb-1 last:border-0 dark:border-white/5"
              >
                <a
                  href={r.href}
                  className="shrink-0 text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                >
                  {r.date}
                </a>
                <span className="tabular-nums text-slate-600 dark:text-slate-300">
                  {r.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
