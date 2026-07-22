import Link from "next/link";
import { IconMoon, IconArrowRight } from "@tabler/icons-react";
import {
  baselineDeltaPhrase,
  formatHm,
  type LastNightSummary,
  type SleepRecordPresentation,
} from "@/lib/sleep-summary";
import { formatClockMinutes, type TimeFormat } from "@/lib/format-date";
import { timelineDayHref } from "@/lib/hrefs";
import { chartSeries } from "@/lib/chart-colors";
import { activityProvenanceLabel } from "@/lib/journal-format";
import type { BedtimeSupplementSummary } from "@/lib/sleep-bedtime-supplements";
import BedtimeSupplementStatus from "./BedtimeSupplementStatus";

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
  presentation,
  bedtimeSupplements,
}: {
  summary: LastNightSummary;
  timeFormat: TimeFormat;
  presentation: SleepRecordPresentation;
  bedtimeSupplements: BedtimeSupplementSummary | null;
}) {
  const delta = baselineDeltaPhrase(summary);
  const source = activityProvenanceLabel(summary.source);
  return (
    <section className="card mb-6" data-testid="sleep-hero">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <IconMoon className="h-5 w-5" stroke={1.75} aria-hidden />
          <span className="section-label" data-testid="sleep-hero-label">
            {presentation.label}
          </span>
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

      <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-3">
        <div>
          <p className="section-label mb-1">Duration</p>
          <p
            className="text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
            data-testid="sleep-hero-duration"
          >
            {formatHm(summary.durationMin)}
          </p>
          {delta && (
            <p
              className="mt-1 text-sm text-slate-500 dark:text-slate-400"
              data-testid="sleep-hero-delta"
            >
              {delta}
            </p>
          )}
        </div>

        <div>
          <p className="section-label mb-1">Sleep window</p>
          <p className="text-xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
            {summary.bedMinutes != null && summary.wakeMinutes != null ? (
              <>
                {formatClockMinutes(timeFormat, summary.bedMinutes)} →{" "}
                {formatClockMinutes(timeFormat, summary.wakeMinutes)}
              </>
            ) : (
              <span className="text-base font-normal text-slate-500 dark:text-slate-400">
                Not recorded
              </span>
            )}
          </p>
        </div>

        <div>
          <p className="section-label mb-1">Recent average</p>
          {summary.baselineAvgMin != null ? (
            <>
              <p className="text-xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {formatHm(summary.baselineAvgMin)}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Based on the prior {summary.baselineNights} recorded nights
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Not enough history yet
            </p>
          )}
        </div>
      </div>

      {summary.napMin > 0 && (
        <p
          className="mt-1 text-sm text-slate-500 dark:text-slate-400"
          data-testid="sleep-hero-nap"
        >
          + {formatHm(summary.napMin)} nap (counted separately)
        </p>
      )}

      {bedtimeSupplements && (
        <div className="mt-3" data-testid="sleep-hero-bedtime-supplements">
          <BedtimeSupplementStatus
            summary={bedtimeSupplements}
            prefix="Bedtime supplements"
            detailsMode="taken-inline"
          />
        </div>
      )}

      {summary.stages && <StageBar stages={summary.stages} />}

      <p
        className="mt-4 text-xs text-slate-500 dark:text-slate-400"
        data-testid="sleep-hero-source"
      >
        {source === "Manual" ? "Logged manually" : `Source: ${source}`}
      </p>
    </section>
  );
}
