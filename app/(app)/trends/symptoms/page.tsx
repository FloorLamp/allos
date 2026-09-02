import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { chartObservationRamp } from "@/lib/chart-colors";
import { MONTHS_LONG } from "@/lib/date";
import {
  SYMPTOM_ANALYSIS_MONTHS,
  buildSymptomAnalysis,
  type SymptomAnalysisEntry,
} from "@/lib/symptom-analysis";
import { severityLabelFor } from "@/lib/symptoms";
import PageContainer from "@/components/PageContainer";
import BackLink from "@/components/BackLink";
import { EmptyState, PageHeader } from "@/components/ui";
import { SeriesSummary } from "@/components/SeriesAccess";

export const dynamic = "force-dynamic";

// Symptom analysis (#1852) — "how many migraine days last month, and is it getting
// worse?". The chronological record is NOT here: `/history` owns the ledger (#3958),
// and a second day-by-day surface is what that issue exists to end. This page answers
// only the counting question, from the one `lib/symptom-analysis` computation.
//
// ONE FIGURE, BOTH HALVES. The month column IS the day-count bar (its height is the
// number of days) and IS the severity strip (each stacked cell is one of those days,
// shaded by that day's severity). Two figures over the same twelve columns would have
// made the reader align them by eye; one cannot disagree with itself. Color is never
// the only encoding — every column prints its own count, every cell carries a dated
// `aria-label` naming its severity in words, and the months are restated as a hidden
// series summary (no `title`: hover is not a reading, #794).

function monthTitle(monthStart: string): string {
  return `${MONTHS_LONG[Number(monthStart.slice(5, 7)) - 1]} ${monthStart.slice(0, 4)}`;
}

function daySummary(
  symptom: string,
  date: string,
  severityByDate: Map<string, number>
): string {
  return `${date} — ${severityLabelFor(symptom, severityByDate.get(date) ?? 1)}`;
}

function SymptomTile({ entry }: { entry: SymptomAnalysisEntry }) {
  const severityByDate = new Map(
    entry.severity.map((point) => [point.date, point.severity])
  );
  const datesByMonth = new Map<string, string[]>();
  for (const point of entry.severity) {
    const month = `${point.date.slice(0, 7)}-01`;
    datesByMonth.set(month, [...(datesByMonth.get(month) ?? []), point.date]);
  }
  const busiest = Math.max(1, ...entry.months.map((m) => m.days));

  return (
    <section className="card" data-testid={`symptom-tile-${entry.symptom}`}>
      <h3 className="font-semibold text-slate-800 dark:text-slate-100">
        {entry.label}
      </h3>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        <span data-testid={`symptom-tile-${entry.symptom}-days`}>
          {entry.days} {entry.days === 1 ? "day" : "days"}
        </span>{" "}
        over {SYMPTOM_ANALYSIS_MONTHS} months · busiest month {busiest}{" "}
        {busiest === 1 ? "day" : "days"}
      </p>
      <ol className="flex items-end gap-1 overflow-x-auto sm:gap-2">
        {entry.months.map((month) => (
          <li
            key={month.month}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
            data-testid={`symptom-month-${entry.symptom}-${month.month.slice(0, 7)}`}
          >
            <span className="flex w-full flex-col-reverse items-stretch gap-px">
              {(datesByMonth.get(month.month) ?? []).map((date) => (
                <span
                  key={date}
                  aria-label={daySummary(entry.symptom, date, severityByDate)}
                  className={`h-1.5 rounded-xs ${chartObservationRamp.stepClasses[(severityByDate.get(date) ?? 1) - 1]}`}
                />
              ))}
              {month.days === 0 && (
                <span
                  className={`h-1.5 rounded-xs ${chartObservationRamp.emptyClass}`}
                />
              )}
            </span>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {month.days}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {month.label}
            </span>
          </li>
        ))}
      </ol>
      {/* The figure in words, for a reader who never sees it; every column already
          PRINTS its count, so the months need no door of their own. */}
      <SeriesSummary
        label={`${entry.label} by month`}
        items={entry.months.map(
          (month) =>
            `${monthTitle(month.month)} — ${month.days} ${month.days === 1 ? "day" : "days"}`
        )}
        data-testid={`symptom-months-${entry.symptom}`}
      />
    </section>
  );
}

export default async function SymptomTrendsPage() {
  const { profile } = await requireSession();
  const analysis = buildSymptomAnalysis(profile.id, today(profile.id));
  const occasional = analysis.entries.filter((entry) => !entry.recurring);

  return (
    <PageContainer
      width="reading"
      className="mx-auto space-y-4 md:space-y-6"
      data-testid="symptom-trends-page"
    >
      <BackLink href="/trends" label="Back to Trends" className="" />
      <PageHeader
        className="mb-0!"
        title="Symptom Trends"
        subtitle="How many days each symptom showed up, month by month, with each day shaded by how bad it was."
      />

      {analysis.entries.length === 0 ? (
        <div className="card">
          <EmptyState
            testId="symptom-trends-empty"
            message="No symptoms logged in the last year. Log a symptom from the day bar and its monthly pattern shows up here."
          />
        </div>
      ) : (
        <div className="space-y-4" data-testid="symptom-trends-tiles">
          {analysis.recurring.map((entry) => (
            <SymptomTile key={entry.symptom} entry={entry} />
          ))}
          {analysis.recurring.length === 0 && (
            <div className="card">
              <EmptyState message="Nothing has come back often enough yet to show a pattern. A symptom gets a chart once it has been logged on three days across two months." />
            </div>
          )}
          {occasional.length > 0 && (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="symptom-trends-occasional"
            >
              Also logged:{" "}
              {occasional
                .map(
                  (entry) =>
                    `${entry.label} (${entry.days} ${entry.days === 1 ? "day" : "days"})`
                )
                .join(", ")}
              .
            </p>
          )}
        </div>
      )}
    </PageContainer>
  );
}
