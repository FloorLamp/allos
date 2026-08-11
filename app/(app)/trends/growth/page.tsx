import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getBodyMetricDailySeries, getMetricDailyTotals } from "@/lib/queries";
import { getUnitPrefs, getUserBirthdate, getUserSex } from "@/lib/settings";
import { ALL_ROWS } from "@/lib/trends";
import { buildGrowthTrendPresentation } from "@/lib/growth-trend-views";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  normalizeTimelineRange,
  resolveTrendsRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import type { AppRoute } from "@/lib/hrefs";
import PageContainer from "@/components/PageContainer";
import GrowthChartsCard from "@/components/GrowthChartsCard";
import DateRangeControl from "@/components/DateRangeControl";
import { EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function GrowthTrendsPage(props: {
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    range?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const weightUnit = getUnitPrefs(login.id).weightUnit;
  const todayStr = today(profile.id);
  const range = resolveTrendsRange(
    normalizeTimelineRange(
      timelineDateFromParam(searchParams.from),
      timelineDateFromParam(searchParams.to)
    ),
    todayStr,
    Array.isArray(searchParams.range)
      ? searchParams.range[0]
      : searchParams.range
  );
  const rangeHref = (next: DateRange): AppRoute => {
    const params = new URLSearchParams();
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    if (isAllTimeRange(next))
      params.set(ALL_TIME_RANGE_PARAM, ALL_TIME_RANGE_VALUE);
    const query = params.toString();
    return (query ? `/trends/growth?${query}` : "/trends/growth") as AppRoute;
  };
  const presentation = buildGrowthTrendPresentation({
    sex: getUserSex(profile.id),
    birthdate: getUserBirthdate(profile.id),
    today: todayStr,
    heights: getMetricDailyTotals(profile.id, "height_cm", ALL_ROWS).map(
      (row) => ({ date: row.date, value: row.value })
    ),
    weights: getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS).map(
      (row) => ({ date: row.date, value: row.value })
    ),
    headCircs: getMetricDailyTotals(
      profile.id,
      "head_circumference_cm",
      ALL_ROWS
    ).map((row) => ({ date: row.date, value: row.value })),
    weightUnit,
    range,
  });

  return (
    <PageContainer
      width="wide"
      className="mx-auto space-y-4 md:space-y-6"
      data-testid="growth-detail-page"
    >
      <div>
        <Link
          href="/trends#body"
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-brand-700 hover:bg-brand-50 hover:no-underline dark:text-brand-400 dark:hover:bg-brand-950/40"
        >
          <IconArrowLeft className="h-4 w-4" aria-hidden />
          Back to Body
        </Link>
        <PageHeader
          className="mb-0! mt-3"
          title="Growth Percentiles"
          subtitle="WHO and CDC reference trajectories across height, weight, body mass index, and head circumference."
        />
      </div>

      <DateRangeControl
        basePath="/trends/growth"
        range={range}
        todayStr={todayStr}
        buildHref={rangeHref}
        idPrefix="growth"
      />

      {presentation ? (
        <GrowthChartsCard
          views={presentation.views}
          currentAgeMonths={presentation.currentAgeMonths}
          source={presentation.source}
        />
      ) : (
        <div className="card">
          <EmptyState message="Growth percentile charts require an eligible child profile with a recorded birthdate, sex, and growth measurement." />
        </div>
      )}
    </PageContainer>
  );
}
