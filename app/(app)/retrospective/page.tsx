import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import SegmentedControl from "@/components/SegmentedControl";
import { recapRangeLabel } from "@/lib/recap";
import { recapScaleEntry } from "@/lib/recap-scale";
import { retrospectiveHref } from "@/lib/hrefs";
import { firstLoggedDay, getRetrospective } from "@/lib/retrospective-data";
import {
  resolveRetrospectiveYear,
  retrospectiveCoverage,
  retrospectiveCoverageSentence,
  retrospectiveYears,
} from "@/lib/retrospective";
import RetrospectiveLines from "./RetrospectiveLines";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Year in review" };

// THE ANNUAL RETROSPECTIVE (#2179) — a rendered "year in health" surface.
//
// Its whole posture, in three sentences. It is USER-INITIATED: you come here, nothing
// arrives. It is COMMEMORATIVE rather than evaluative, which is the one place the
// recap's "never re-total" rule is deliberately bent — a year is allowed to keep its
// counts as a RECORD, and pays for that by attaching no comparison to any of them
// (`countsAsRecordAt`, enforced inside `buildRecap`). And it RE-PRESENTS: every number
// on this page is the recap engine's number at `scale: "year"`, so it cannot disagree
// with the dashboard card or the periodic send.
//
// SHIPPED IN THIS SLICE: the page, the year picker, and the honest coverage line. NOT
// shipped, deliberately: the once-a-year POINTER SEND and its Settings toggle (a
// contact increase that stacks beside the chosen review cadence, so it is its own
// decision), the AI narrative, and the year-native blocks the issue names — seasonality,
// the annual medical rhythm, biomarker year-over-year, and the child-growth variant.
// Each of those is a new gather rather than a new arrangement of this one.
export default async function RetrospectivePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const { profile, login } = await requireSession();
  const td = today(profile.id);
  const first = firstLoggedDay(profile.id);
  const years = retrospectiveYears(first, td);
  const year = resolveRetrospectiveYear((await searchParams).year, years);

  const formatPrefs = getDisplayFormatPrefs(login.id);
  const recap = getRetrospective(
    profile.id,
    year,
    td,
    getUnitPrefs(login.id).weightUnit
  );
  const coverage = retrospectiveCoverage(year, first, td);
  const coverageSentence = retrospectiveCoverageSentence(coverage, formatPrefs);

  return (
    <PageContainer width="reading" className="mx-auto">
      <PageHeader
        title={`${year} in review`}
        subtitle={recapScaleEntry("year").blurb}
      />

      {years.length > 1 && (
        <div className="-mx-1 mb-5 overflow-x-auto px-1 pb-1">
          <SegmentedControl
            ariaLabel="Retrospective year"
            value={year}
            options={years.map((y) => ({
              value: y,
              label: String(y),
              href: retrospectiveHref(y),
              testId: `retrospective-year-${y}`,
            }))}
            testId="retrospective-years"
          />
        </div>
      )}

      <div className="card" data-testid="retrospective">
        <div className="mb-3 space-y-1">
          <p
            className="text-sm text-slate-500 dark:text-slate-400"
            data-testid="retrospective-range"
          >
            {recapRangeLabel(recap.start, recap.end, formatPrefs)}
          </p>
          {/* The honest partial-window line. A year that began in March, or one still
              running, says so — the counts below must never imply twelve months they
              did not have. Null (and absent) for a whole, closed year. */}
          {coverageSentence && (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="retrospective-coverage"
            >
              {coverageSentence}
            </p>
          )}
        </div>

        {recap.headline && (
          <p
            className="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-100"
            data-testid="retrospective-headline"
          >
            {recap.headline}
          </p>
        )}

        {recap.lines.length === 0 ? (
          <EmptyState
            testId="retrospective-empty"
            compact
            message={`Nothing logged in ${year} yet. A workout or a weigh-in is enough to start this year's record.`}
            action={{ href: "/training", label: "Log a workout" }}
          />
        ) : (
          <RetrospectiveLines recap={recap} />
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Counts on this page are kept as a record, not as a verdict — nothing
        here is compared against another year&rsquo;s tally. Trajectories carry
        the comparisons.
      </p>
    </PageContainer>
  );
}
