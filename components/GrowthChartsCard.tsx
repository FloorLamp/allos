import GrowthChart from "./GrowthChart";
import ChartCard from "./ChartCard";
import { EmptyState } from "./ui";
import { ordinalPercentile } from "@/lib/growth-format";
import type { GrowthTrendView } from "@/lib/growth-trend-views";
import { growthTrendsHref, type AppRoute } from "@/lib/hrefs";

export type GrowthMetricView = GrowthTrendView;

// The growth-chart group for the Body Metrics page: one independent WHO/CDC chart
// card per available anthropometric. These used to be collapsed behind a metric
// switcher, which made four distinct clinical references look like one metric and
// gave the tile view only one representative series.
export default function GrowthChartsCard({
  views,
  currentAgeMonths,
  source,
  detailHref,
  range,
}: {
  views: GrowthMetricView[];
  currentAgeMonths: number;
  // "WHO" (0–2 y) or "CDC" (2–20 y) — which reference the current age uses.
  source: string;
  // The Body hub links its large card to the composite detail page. Omitted on
  // that detail page itself so the header never self-links.
  detailHref?: AppRoute;
  range?: { from?: string; to?: string };
}) {
  if (views.length === 0) return null;
  const orderedViews = [
    ...views.filter((view) => view.latestPercentile != null),
    ...views.filter((view) => view.latestPercentile == null),
  ];

  return (
    <section className="space-y-3" data-testid="growth-charts-card">
      {detailHref && (
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Growth Percentiles
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Separate {source} reference trajectories for each growth measure.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {orderedViews.map((view) => (
          <ChartCard
            key={view.metric}
            anchorId={`growth-${view.metric}`}
            testid={`growth-chart-${view.metric}`}
            title={view.percentileTitle}
            headline={
              view.latestPercentile == null
                ? undefined
                : ordinalPercentile(view.latestPercentile)
            }
            description={`${view.referenceSource} ${view.label.toLowerCase()}-for-age reference`}
            detailHref={
              detailHref ? growthTrendsHref(view.metric, range) : null
            }
            detailTitle={view.percentileTitle}
            footer={
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Reference curves (WHO 0–2 y, CDC 2–20 y).
              </p>
            }
          >
            {view.latestPercentile != null && view.bands.length > 0 ? (
              <GrowthChart
                bands={view.bands}
                points={view.points}
                currentAgeMonths={currentAgeMonths}
                minMonths={view.minMonths}
                maxMonths={view.maxMonths}
                unit={view.unit}
                valueRound={view.valueRound}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center *:w-full">
                <EmptyState
                  message={
                    !view.referenceAvailable
                      ? `${view.percentileTitle} is not available for this age.`
                      : `No ${view.label.toLowerCase()} measurement is available in this date range.`
                  }
                />
              </div>
            )}
          </ChartCard>
        ))}
      </div>
    </section>
  );
}
