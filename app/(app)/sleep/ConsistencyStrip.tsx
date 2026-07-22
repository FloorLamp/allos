import Link from "next/link";
import type { ConsistencyNight } from "@/lib/sleep-summary";
import { formatClockMinutes, type TimeFormat } from "@/lib/format-date";
import { timelineDayHref } from "@/lib/hrefs";
import { chartSeries } from "@/lib/chart-colors";

// The consistency strip (issue #1066): the MAIN overnight bed→wake window per
// night (#1118 — naps already dropped), plotted on a shared noon-to-noon (12→36h)
// axis so a steady schedule reads as vertically aligned bars and drift reads as a
// ragged edge. Weekend nights are tinted so the weekday/weekend split is visible.
// Each row links to that day's Timeline view ("see in day context"). Formatter
// only over getSleepConsistency — no new computation.

const AXIS_START = 12; // noon
const AXIS_SPAN = 24; // to next noon

function pct(hour: number): number {
  return ((hour - AXIS_START) / AXIS_SPAN) * 100;
}

// Pref-aware wall clock from a noon-anchored decimal hour (12→36). The hour is a
// NUMBER; the render layer picks the 12h/24h convention via formatClockMinutes
// (#1163) — no hand-rolled padStart clock string.
function clock(hour: number, timeFormat: TimeFormat): string {
  return formatClockMinutes(timeFormat, Math.round(hour * 60));
}

export default function ConsistencyStrip({
  nights,
  timeFormat,
}: {
  nights: ConsistencyNight[];
  timeFormat: TimeFormat;
}) {
  // Newest first so the most recent night is at the top.
  const rows = [...nights].reverse();
  return (
    <div data-testid="sleep-consistency" className="card">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Sleep consistency
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Each bar is one night&apos;s bed → wake window on a shared noon-to-noon
        axis. Aligned bars mean a steady schedule; weekends are tinted.
      </p>
      <div className="flex flex-col gap-1">
        {rows.map((n) => (
          <Link
            key={n.date}
            href={timelineDayHref(n.date)}
            className="group flex items-center gap-3 rounded px-1 py-0.5 transition hover:bg-slate-50 dark:hover:bg-ink-800"
            data-testid="sleep-consistency-night"
          >
            <span className="w-16 shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {n.date.slice(5)}
            </span>
            <span className="relative h-4 flex-1 rounded bg-slate-100 dark:bg-ink-800">
              <span
                className="absolute top-0 h-full rounded"
                style={{
                  left: `${pct(n.bedHour)}%`,
                  width: `${pct(n.wakeHour) - pct(n.bedHour)}%`,
                  backgroundColor: n.weekend
                    ? chartSeries.amber
                    : chartSeries.violet,
                }}
                title={`${clock(n.bedHour, timeFormat)} → ${clock(
                  n.wakeHour,
                  timeFormat
                )}`}
              />
            </span>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {clock(n.bedHour, timeFormat)}–{clock(n.wakeHour, timeFormat)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
