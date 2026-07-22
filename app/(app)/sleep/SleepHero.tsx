import Link from "next/link";
import { IconMoon, IconArrowRight } from "@tabler/icons-react";
import {
  baselineDeltaPhrase,
  formatHm,
  type LastNightSummary,
} from "@/lib/sleep-summary";
import { formatClockMinutes, type TimeFormat } from "@/lib/format-date";
import { timelineDayHref } from "@/lib/hrefs";
import { chartSeries } from "@/lib/chart-colors";

// The Sleep page hero (issue #1066): last night reduced to facts — duration, a
// stage stacked bar, bed/wake, and the delta vs the trailing-30-night baseline —
// ALL of the MAIN overnight session (#1118). A same-day nap is a SEPARATE small
// line, never folded into the total. Deliberately factual, never scored (no
// invented sleep score — the pillars-not-a-composite stance). Formatter only over
// the shared lastNightSummary model the dashboard tile also reads.

const STAGE_META: {
  key: keyof NonNullable<LastNightSummary["stages"]>;
  label: string;
  color: string;
}[] = [
  { key: "deep", label: "Deep", color: chartSeries.violet },
  { key: "rem", label: "REM", color: chartSeries.rose },
  { key: "light", label: "Light", color: chartSeries.emerald },
  { key: "awake", label: "Awake", color: chartSeries.amber },
];

function StageBar({
  stages,
}: {
  stages: NonNullable<LastNightSummary["stages"]>;
}) {
  const total = STAGE_META.reduce((t, s) => t + Math.max(0, stages[s.key]), 0);
  if (total <= 0) return null;
  return (
    <div data-testid="sleep-hero-stages" className="mt-4">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {STAGE_META.map((s) => {
          const pct = (Math.max(0, stages[s.key]) / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={s.key}
              style={{ width: `${pct}%`, backgroundColor: s.color }}
              title={`${s.label} ${formatHm(stages[s.key])}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {STAGE_META.map((s) =>
          stages[s.key] > 0 ? (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {s.label} {formatHm(stages[s.key])}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
}

export default function SleepHero({
  summary,
  timeFormat,
}: {
  summary: LastNightSummary;
  timeFormat: TimeFormat;
}) {
  const delta = baselineDeltaPhrase(summary);
  return (
    <section className="card mb-6" data-testid="sleep-hero">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <IconMoon className="h-5 w-5" stroke={1.75} aria-hidden />
          <span className="section-label">Last night</span>
        </div>
        <Link
          href={timelineDayHref(summary.wakeDay)}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          data-testid="sleep-hero-day-link"
        >
          See in day context
          <IconArrowRight className="h-4 w-4" stroke={1.75} aria-hidden />
        </Link>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className="text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
          data-testid="sleep-hero-duration"
        >
          {formatHm(summary.durationMin)}
        </span>
        {delta && (
          <span
            className="text-sm text-slate-500 dark:text-slate-400"
            data-testid="sleep-hero-delta"
          >
            {delta}
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Asleep {formatClockMinutes(timeFormat, summary.bedMinutes)} →{" "}
        {formatClockMinutes(timeFormat, summary.wakeMinutes)}
        {summary.baselineAvgMin != null && (
          <>
            {" "}
            · {formatHm(summary.baselineAvgMin)} average over the last{" "}
            {summary.baselineNights} nights
          </>
        )}
      </p>

      {summary.napMin > 0 && (
        <p
          className="mt-1 text-sm text-slate-500 dark:text-slate-400"
          data-testid="sleep-hero-nap"
        >
          + {formatHm(summary.napMin)} nap (counted separately)
        </p>
      )}

      {summary.stages && <StageBar stages={summary.stages} />}
    </section>
  );
}
