"use client";

import Link from "next/link";
import { useState } from "react";
import { consistencyPlot, type ConsistencyNight } from "@/lib/sleep-summary";
import {
  formatClockMinutes,
  formatMonthDay,
  type TimeFormat,
} from "@/lib/format-date";
import { timelineDayHref } from "@/lib/hrefs";
import { chartSeries } from "@/lib/chart-colors";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// The consistency strip (issue #1066): the MAIN overnight bed→wake window per
// night (#1118 — naps already dropped), plotted on a shared axis aligned to the
// profile's own observed sleep phase (#1190). A steady schedule reads as vertically
// aligned bars and drift reads as a ragged edge regardless of whether sleep ends
// before or after noon. Weekend nights are tinted so the split is visible.
// Each row links to that day's Timeline view ("see in day context"). The pure
// plotting helper owns phase alignment; this component only formats and renders it.

// Pref-aware wall clock from a decimal hour (which may exceed 24 for an unwrapped
// wake). The render layer picks the 12h/24h convention via formatClockMinutes
// (#1163) — no hand-rolled clock string.
function clock(hour: number, timeFormat: TimeFormat): string {
  return formatClockMinutes(timeFormat, Math.round(hour * 60));
}

function clockRange(night: ConsistencyNight, timeFormat: TimeFormat): string {
  return `${clock(night.bedHour, timeFormat)} → ${clock(
    night.wakeHour,
    timeFormat
  )}`;
}

export default function ConsistencyStrip({
  nights,
  timeFormat,
}: {
  nights: ConsistencyNight[];
  timeFormat: TimeFormat;
}) {
  const formatPrefs = useFormatPrefs();
  const [expanded, setExpanded] = useState(false);
  const plot = consistencyPlot(nights);
  // Newest first so the most recent night is at the top.
  const rows = [...plot.nights].reverse();
  const shown = expanded ? rows : rows.slice(0, 14);
  return (
    <div data-testid="sleep-consistency" className="card">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Sleep consistency
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Each bar is one sleep window on an axis aligned to your sleep timing.
        Rose-highlighted rows were more than 1 hour from your typical bedtime or
        wake time.
      </p>
      <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: chartSeries.violet }}
            aria-hidden
          />
          Weekday
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: chartSeries.amber }}
            aria-hidden
          />
          Weekend
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm border border-rose-400 bg-rose-50 dark:bg-rose-950/40"
            aria-hidden
          />
          Off schedule
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {shown.map((n) => (
          <Link
            key={n.date}
            href={timelineDayHref(n.date)}
            className={`group flex items-center gap-3 rounded px-1 py-0.5 transition ${
              n.offSchedule
                ? "bg-rose-50/80 ring-1 ring-inset ring-rose-200 hover:bg-rose-100/80 dark:bg-rose-950/20 dark:ring-rose-900 dark:hover:bg-rose-950/35"
                : "hover:bg-slate-50 dark:hover:bg-ink-800"
            }`}
            data-testid="sleep-consistency-night"
            data-off-schedule={n.offSchedule ? "true" : "false"}
            data-date={n.date}
            aria-label={`${n.date}, ${
              n.offSchedule ? "off schedule, " : ""
            }${clock(n.bedHour, timeFormat)} to ${clock(
              n.wakeHour,
              timeFormat
            )}`}
          >
            <span
              className={`w-20 shrink-0 text-xs tabular-nums ${
                n.offSchedule
                  ? "font-medium text-rose-700 dark:text-rose-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {formatMonthDay(n.date, formatPrefs)}
            </span>
            <span className="relative h-4 flex-1 rounded bg-slate-100 dark:bg-ink-800">
              <span
                className="absolute top-0 h-full rounded"
                style={{
                  left: `${n.leftPct}%`,
                  width: `${n.widthPct}%`,
                  backgroundColor: n.weekend
                    ? chartSeries.amber
                    : chartSeries.violet,
                }}
                title={clockRange(n, timeFormat)}
                data-testid="sleep-consistency-bar"
              />
            </span>
            <span
              className="w-32 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-slate-500 sm:w-36 dark:text-slate-400"
              data-testid="sleep-consistency-time"
            >
              {clockRange(n, timeFormat)}
            </span>
          </Link>
        ))}
      </div>
      {rows.length > 14 && (
        <button
          type="button"
          className="mt-3 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          data-testid="sleep-consistency-toggle"
        >
          {expanded ? "Show fewer" : `Show all ${rows.length} nights`}
        </button>
      )}
    </div>
  );
}
