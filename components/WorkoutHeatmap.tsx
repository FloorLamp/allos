"use client";

import { useState } from "react";
import Link from "next/link";
import type { HeatmapCell, WorkoutHeatmap } from "@/lib/workout-heatmap";

// Single-letter weekday labels indexed by 0=Sun … 6=Sat.
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

// Color bucket per intensity level (0 = none … 4 = 4+ sessions). Emerald ramp,
// theme-aware; level 0 is a neutral empty cell.
const LEVEL_CLASS = [
  "bg-slate-100 dark:bg-ink-800",
  "bg-emerald-200 dark:bg-emerald-900",
  "bg-emerald-300 dark:bg-emerald-700",
  "bg-emerald-400 dark:bg-emerald-600",
  "bg-emerald-500 dark:bg-emerald-400",
];

function cellSummary(cell: HeatmapCell): string {
  if (cell.count === 0) return `${cell.date} — no workouts`;
  const sessions = `${cell.count} ${cell.count === 1 ? "session" : "sessions"}`;
  const mins = cell.minutes > 0 ? ` · ${cell.minutes} min` : "";
  return `${cell.date} — ${sessions}${mins}`;
}

// GitHub-style workout-density calendar (issue #186). A server component fetches
// the pre-built grid (lib/workout-heatmap); this is the thin client layer that
// draws the cells, tracks a hovered/focused cell for the detail caption, and
// deep-links each active day to the Timeline (the sidebar calendar's pattern).
export default function WorkoutHeatmapView({
  data,
  testId = "workout-heatmap",
}: {
  data: WorkoutHeatmap;
  testId?: string;
}) {
  const [active, setActive] = useState<HeatmapCell | null>(null);

  const detail = active
    ? cellSummary(active)
    : `${data.totalSessions} ${
        data.totalSessions === 1 ? "session" : "sessions"
      } over ${data.activeDays} ${
        data.activeDays === 1 ? "day" : "days"
      } · ${data.totalMinutes} min`;

  return (
    <div data-testid={testId}>
      <div className="overflow-x-auto">
        <div className="inline-block min-w-full">
          {/* Month labels, aligned to their columns. */}
          <div className="flex pl-6 text-[10px] text-slate-500 dark:text-slate-400">
            <div className="flex gap-[3px]">
              {data.columns.map((_, col) => {
                const label = data.monthLabels.find((m) => m.col === col);
                return (
                  <div key={col} className="w-[11px] shrink-0">
                    {label ? label.label : ""}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex">
            {/* Weekday rail: label alternating rows to save space. */}
            <div className="mr-1 flex flex-col gap-[3px] pt-[1px] text-[10px] text-slate-500 dark:text-slate-400">
              {data.weekdayOrder.map((wd, row) => (
                <div
                  key={row}
                  className="flex h-[11px] w-4 items-center justify-end"
                >
                  {row % 2 === 1 ? DOW[wd] : ""}
                </div>
              ))}
            </div>

            {/* Week columns. */}
            <div className="flex gap-[3px]">
              {data.columns.map((col, ci) => (
                <div key={ci} className="flex flex-col gap-[3px]">
                  {col.map((cell) => {
                    if (cell.future) {
                      return (
                        <div
                          key={cell.date}
                          className="h-[11px] w-[11px]"
                          aria-hidden="true"
                        />
                      );
                    }
                    const cls = `h-[11px] w-[11px] rounded-[2px] ${
                      LEVEL_CLASS[cell.level]
                    }`;
                    const common = {
                      title: cellSummary(cell),
                      onMouseEnter: () => setActive(cell),
                      onMouseLeave: () => setActive(null),
                      onFocus: () => setActive(cell),
                      onBlur: () => setActive(null),
                    };
                    if (cell.count > 0) {
                      return (
                        <Link
                          key={cell.date}
                          href={`/timeline?from=${cell.date}&to=${cell.date}#timeline-day-${cell.date}`}
                          data-testid="heatmap-day"
                          data-date={cell.date}
                          data-count={cell.count}
                          data-level={cell.level}
                          aria-label={cellSummary(cell)}
                          className={`${cls} block ring-brand-400 hover:ring-2 focus:outline-none focus:ring-2`}
                          {...common}
                        />
                      );
                    }
                    return (
                      <div
                        key={cell.date}
                        data-date={cell.date}
                        aria-label={cellSummary(cell)}
                        className={cls}
                        {...common}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Detail caption + legend. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p
          data-testid="heatmap-detail"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {detail}
        </p>
        <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
          <span>Less</span>
          {LEVEL_CLASS.map((c, i) => (
            <span key={i} className={`h-[11px] w-[11px] rounded-[2px] ${c}`} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
