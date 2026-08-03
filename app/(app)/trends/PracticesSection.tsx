import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getPracticeTrends, type PracticeTrend } from "@/lib/queries";
import { practiceCadenceText } from "@/lib/practice";
import {
  MAX_PRACTICE_TREND_CARDS,
  PRACTICE_VERDICT_LABEL,
  practiceConsistencyText,
  practiceTrendWindow,
  type PracticeWeekVerdict,
} from "@/lib/trends-practices";
import { chartAdherenceState, chartSeries } from "@/lib/chart-colors";
import type { DateRange } from "@/lib/timeline-format";
import ChartCard from "@/components/ChartCard";
import TrendsSectionShell from "./TrendsSectionShell";
import LineChartCard from "@/components/LineChartCard";

// Trends → the WELLNESS LENS (issue #1632).
//
// Practices were the one logged domain Trends did not know existed: nothing under
// `app/(app)/trends/` mentioned them, so "how consistent has my sauna habit
// actually been?" had no answer anywhere in the app — `/wellness` shows this
// week's pace and a raw session list, and that is all.
//
// This section answers it on the landing surface, in the three shapes the stored
// data already supports:
//
//   1. WEEKS IN RANGE — one cell per completed week: at the weekly maximum, floor
//      met, or under floor. The verdicts are `frequencyRangeState` with the week
//      elapsed (lib/trends-practices), i.e. the SAME computation the /wellness
//      card, the Goals-and-habits widget, Upcoming and the Telegram nudge key on.
//      Trends formats those decisions; it never re-derives them (#221).
//   2. CADENCE OVER TIME — sessions per week charted against the min–max BAND, so
//      the range the user declared is visible behind the line rather than implied.
//   3. SESSION LENGTH — the duration trend for the modalities that record one
//      (sauna, red light). Practices that log no minutes get no chart rather than
//      a zero-filled one.
//
// REACH POLICY. Practice signals are coaching-tier — calm and hideable — so this
// surface carries no badge, no count, no "behind" state and no rose: an
// under-floor week takes the NEUTRAL cell, and being at the ceiling is a success,
// never a warning (#1259). It carries no RUN either (#1966): the card's note used
// to append an "N-week streak" to the met-week rate, which gave one missed week a
// cliff on the one surface whose whole point is that an under-floor week is a
// fact rather than a nag. The cells and the rate stay; the run is gone. It is
// also an entry point BACK to /wellness (#1620): every card taps through to the
// page that owns logging and editing.
//
// WHY IT RENDERS INLINE, not through the census's Suspense boundary: this is two
// bounded queries (the shared completed-weeks history read plus one grouped tally
// of the window's sessions), not the census's ~30. It also renders NOTHING for a
// profile with no tracked practice, so the head pays for it only where it has
// something to say.

// One completed week's cell tint. Deliberately the ALREADY-BLESSED adherence-cell
// vocabulary (lib/chart-colors) rather than a fourth hand-rolled ramp:
//
//   • at-ceiling → the full brand step. The week reached the cap the user set —
//     the most complete state a range target has.
//   • met        → the pale step of the SAME ramp. Literally less of the same
//     thing (fewer sessions than the cap), which is what that step means there.
//   • under      → the NEUTRAL, never the rose. A missed dose is a safety signal;
//     a practice under its floor is a fact about a coaching-tier habit, and
//     painting it red is exactly the attention badge this lens must not grow.
//
// Colour is never the only encoding: each cell also carries its verdict as text
// (title + screen-reader label + `data-verdict`) and the strip carries a legend.
const VERDICT_CELL: Record<PracticeWeekVerdict, string> = {
  "at-ceiling": chartAdherenceState.taken.class,
  met: chartAdherenceState.partial.class,
  under: chartAdherenceState.skipped.class,
};

// The three states, in "most complete first" order, for the strip legend.
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
            className={`h-4 w-4 rounded-sm ${VERDICT_CELL[week.verdict]}`}
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
                className={`h-2.5 w-2.5 rounded-sm ${VERDICT_CELL[verdict]}`}
              />
              {PRACTICE_VERDICT_LABEL[verdict]}
            </span>
          )
        )}
      </p>
    </div>
  );
}

export default async function PracticesSection({
  range,
}: {
  range: DateRange;
}) {
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  // The hub's shared window decides HOW MANY completed weeks the lens shows and
  // WHICH day anchors them — a range that ends in the past gets the weeks before
  // its own end, not the weeks before today (lib/queries/frequency-targets).
  const window = practiceTrendWindow(range, todayStr);
  const practices = getPracticeTrends(profile.id, window.weeks, window.asOf);
  // Nothing tracked, nothing to say. A practice with no weekly cadence has no
  // floor and no ceiling, so "weeks in range" is not a question about it; its
  // history stays on /wellness.
  if (practices.length === 0) return null;

  const shown = practices.slice(0, MAX_PRACTICE_TREND_CARDS);
  const hidden = practices.length - shown.length;

  return (
    <TrendsSectionShell
      id="practices"
      heading="Practices"
      description="How consistently your wellness practices held their weekly range."
    >
      <div className="space-y-4" data-testid="trends-practices">
        <div className="grid gap-4 md:grid-cols-2">
          {shown.map((practice) => {
            const weekly = practiceCadenceText(
              practice.perWeek,
              practice.perWeekMax
            );
            const cadence = practice.weeks.map((week) => ({
              date: week.start,
              value: week.count,
            }));
            return (
              <div key={practice.identity} className="contents">
                <ChartCard
                  testid="practice-cadence-card"
                  title={practice.name}
                  headingLevel="h3"
                  headline={weekly}
                  description="Days logged per completed week, dated by the week's first day, against your weekly range."
                  note={practiceConsistencyText(practice.consistency)}
                  detailHref="/wellness"
                  detailTitle={practice.name}
                  plotHeightClass="sm:h-48"
                  footer={<WeeksInRange practice={practice} />}
                >
                  <LineChartCard
                    data={cadence}
                    label="Days logged"
                    color={chartSeries.brand}
                    unit=" days"
                    decimals={0}
                    yDomain={[0, "auto"]}
                    // A range target gets the BAND it actually declared; a
                    // floor-only target gets the single line it actually declared.
                    // Never both, and never two lines the reader has to join.
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
                    title={`${practice.name} — session length`}
                    headingLevel="h3"
                    description="Average recorded minutes per day you practised."
                    detailHref="/wellness"
                    detailTitle={`${practice.name} session length`}
                    plotHeightClass="sm:h-48"
                  >
                    <LineChartCard
                      data={practice.duration}
                      label="Minutes"
                      color={chartSeries.violet}
                      unit=" min"
                      decimals={0}
                    />
                  </ChartCard>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400">
          {hidden > 0
            ? `${hidden} more ${
                hidden === 1 ? "practice" : "practices"
              } — logging, session history and weekly goals live on `
            : "Logging, session history and weekly goals live on "}
          <Link
            href="/wellness"
            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            Wellness
          </Link>
          .
        </p>
      </div>
    </TrendsSectionShell>
  );
}
