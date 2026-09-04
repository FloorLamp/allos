import { IconMoon } from "@tabler/icons-react";
import DestinationLink from "@/components/DestinationLink";
import {
  baselineDeltaPhrase,
  formatHm,
  formatSleepWindow,
  type LastNightSummary,
  type SleepRecordPresentation,
} from "@/lib/sleep-summary";
import { formatClockMinutes } from "@/lib/format-date";
import { SLEEP_SKEW_HEDGE, sleepSkewSettledLine } from "@/lib/sleep-clock-skew";
import type { TimeFormat } from "@/lib/format-date";
import { historyDayHref } from "@/lib/hrefs";
import { chartSeries } from "@/lib/chart-colors";
import { activityProvenanceLabel } from "@/lib/training-log-format";
import type { BedtimeSupplementSummary } from "@/lib/sleep-bedtime-supplements";
import BedtimeSupplementStatus from "./BedtimeSupplementStatus";

// The Sleep page hero (issue #1066): last night reduced to facts — duration, a
// stage stacked bar, bed/wake, and the delta vs the trailing-30-night baseline —
// ALL of the MAIN overnight session (#1118). Naps have their own detailed card
// below, so this hero stays exclusively about the night. Deliberately factual,
// never scored (no invented sleep score — the pillars-not-a-composite stance).
// Formatter only over the shared lastNightSummary model the dashboard sleep presentation reads.

const STAGE_META: {
  key: keyof NonNullable<LastNightSummary["stages"]>;
  label: string;
  color: string;
}[] = [
  { key: "deep", label: "Deep", color: chartSeries.violet },
  { key: "rem", label: "REM", color: chartSeries.rose },
  { key: "light", label: "Light", color: chartSeries.sky },
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
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {STAGE_META.map((s) =>
          stages[s.key] > 0 ? (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-xs"
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
  usualSleepBand,
  clockSkewSuspect = false,
  clockSkewSettledMinutes = null,
}: {
  summary: LastNightSummary;
  timeFormat: TimeFormat;
  presentation: SleepRecordPresentation;
  bedtimeSupplements: BedtimeSupplementSummary | null;
  usualSleepBand: string | null;
  // This night's synced session disagrees with the heart rate recorded across it
  // (#4299). The window is still SHOWN — it is what the source stated, and hiding it
  // would leave nothing to recognise as wrong — but it is no longer stated as fact, and
  // the usual band it would be compared against is withheld.
  clockSkewSuspect?: boolean;
  /** Minutes since profile-local midnight where the heart rate settled, for the hedge's
   *  second line (#5021). Null when the evidence carries no usable instant. */
  clockSkewSettledMinutes?: number | null;
}) {
  const delta = baselineDeltaPhrase(summary);
  const source = activityProvenanceLabel(summary.source);
  return (
    <section className="card section-seam mb-6" data-testid="sleep-hero">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <IconMoon className="h-5 w-5" stroke={1.75} aria-hidden />
          <span className="section-label" data-testid="sleep-hero-label">
            {presentation.label}
          </span>
        </div>
        <DestinationLink
          href={historyDayHref(summary.wakeDay)}
          className="inline-flex items-center gap-1 text-sm text-link"
          data-testid="sleep-hero-day-link"
        >
          See in day context
        </DestinationLink>
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
              formatSleepWindow(
                timeFormat,
                summary.bedMinutes,
                summary.wakeMinutes
              )
            ) : (
              <span className="text-base font-normal text-slate-500 dark:text-slate-400">
                Not recorded
              </span>
            )}
          </p>
          {clockSkewSuspect ? (
            <p
              className="mt-1 text-sm text-slate-500 dark:text-slate-400"
              data-testid="sleep-clock-skew-hedge"
            >
              {SLEEP_SKEW_HEDGE}
              {clockSkewSettledMinutes != null && (
                /* WHAT was measured, on its own line — never phrased as a bedtime.
                   The person is the one who knows whether they lay awake first. */
                <span data-testid="sleep-clock-skew-settled">
                  {" "}
                  {sleepSkewSettledLine(
                    formatClockMinutes(timeFormat, clockSkewSettledMinutes)
                  )}
                </span>
              )}
            </p>
          ) : (
            usualSleepBand && (
              <p
                className="mt-1 text-sm tabular-nums text-slate-500 dark:text-slate-400"
                data-testid="sleep-usual-times"
              >
                Usually ~{usualSleepBand}.
              </p>
            )
          )}
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
