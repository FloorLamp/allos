import ChartCard from "@/components/ChartCard";
import LineChartCard from "@/components/LineChartCard";
import { chartAdherenceState, chartSeries } from "@/lib/chart-colors";
import { practiceCadenceText } from "@/lib/practice";
import type { PracticeTrend } from "@/lib/queries/wellness";
import {
  PRACTICE_VERDICT_LABEL,
  practiceConsistencyText,
  type PracticeWeekVerdict,
} from "@/lib/trends-practices";

// One practice, one complete story (#2151): the fixed 26-week lens lives beside
// the practice's affordances and history on /wellness. The card has no competing
// range control; this disclosure is the default, today-anchored lens.
const VERDICT_CELL: Record<PracticeWeekVerdict, string> = {
  "at-ceiling": chartAdherenceState.taken.class,
  met: chartAdherenceState.partial.class,
  under: chartAdherenceState.skipped.class,
};

const LEGEND: PracticeWeekVerdict[] = ["at-ceiling", "met", "under"];

function weekCellTitle(
  week: { start: string; count: number; verdict: PracticeWeekVerdict },
  weekly: string
): string {
  const sessions = `${week.count} ${week.count === 1 ? "day" : "days"}`;
  return `Week of ${week.start} — ${sessions} logged of ${weekly}: ${
    PRACTICE_VERDICT_LABEL[week.verdict]
  }`;
}

function WeeksInRange({ practice }: { practice: PracticeTrend }) {
  const weekly = practiceCadenceText(practice.perWeek, practice.perWeekMax);
  const showLegend = practice.perWeekMax != null;
  return (
    <div className="mt-3" data-testid="practice-weeks-in-range">
      <ol
        className="flex flex-wrap gap-1"
        aria-label="Completed weeks in range"
      >
        {practice.weeks.map((week) => (
          <li
            key={week.start}
            data-testid="practice-week-cell"
            data-verdict={week.verdict}
            title={weekCellTitle(week, weekly)}
            className={`h-4 w-4 rounded-xs ${VERDICT_CELL[week.verdict]}`}
          >
            <span className="sr-only">{weekCellTitle(week, weekly)}</span>
          </li>
        ))}
      </ol>
      <p
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
        data-testid="practice-weeks-legend"
      >
        {LEGEND.filter((verdict) => showLegend || verdict !== "at-ceiling").map(
          (verdict) => (
            <span key={verdict} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={`h-2.5 w-2.5 rounded-xs ${VERDICT_CELL[verdict]}`}
              />
              {PRACTICE_VERDICT_LABEL[verdict]}
            </span>
          )
        )}
      </p>
    </div>
  );
}

export default function PracticeTrends({
  practice,
}: {
  practice: PracticeTrend;
}) {
  const weekly = practiceCadenceText(practice.perWeek, practice.perWeekMax);
  const cadence = practice.weeks.map((week) => ({
    date: week.start,
    value: week.count,
  }));
  const embeddedSurface =
    "rounded-lg border border-black/5 p-4 sm:p-5 dark:border-white/10";

  return (
    <details
      className="border-t border-black/5 pt-3 dark:border-white/10"
      data-testid="wellness-practice-trends"
    >
      <summary className="cursor-pointer text-sm font-medium text-brand-700 dark:text-brand-300">
        26-week trend
      </summary>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Completed weeks through today, using a fixed window of up to 26 weeks.
      </p>
      <div className="mt-3 space-y-3">
        <ChartCard
          testid="practice-cadence-card"
          title="Cadence"
          headingLevel="h3"
          headline={weekly}
          description="Days logged per completed week against your weekly range."
          note={practiceConsistencyText(practice.consistency)}
          detailHref={
            null
          } /* detail-none: this chart already lives on the practice's detail card. */
          surfaceClass={embeddedSurface}
          plotHeightClass="sm:h-48"
          footer={<WeeksInRange practice={practice} />}
        >
          <LineChartCard
            // gap-exempt: WEEK-grain cadence (days logged per completed week),
            // already contiguous over the fixed 26-week lens.
            data={cadence}
            label="Days logged"
            color={chartSeries.brand}
            unit=" days"
            decimals={0}
            yDomain={[0, "auto"]}
            referenceBand={
              practice.perWeekMax != null
                ? { low: practice.perWeek, high: practice.perWeekMax }
                : null
            }
            referenceValue={
              practice.perWeekMax == null
                ? { value: practice.perWeek, label: weekly }
                : null
            }
          />
        </ChartCard>

        {practice.duration.length >= 2 && (
          <ChartCard
            testid="practice-duration-card"
            title="Session length"
            headingLevel="h3"
            description="Average recorded minutes per day you practised."
            detailHref={
              null
            } /* detail-none: this chart already lives on the practice's detail card. */
            surfaceClass={embeddedSurface}
            plotHeightClass="sm:h-48"
          >
            <LineChartCard
              // gap-exempt: week-grain average session length, same lens.
              data={practice.duration}
              label="Minutes"
              color={chartSeries.violet}
              unit=" min"
              decimals={0}
            />
          </ChartCard>
        )}
      </div>
    </details>
  );
}
