import type { ReactNode } from "react";
import TrendMiniCard from "@/components/TrendMiniCard";
import {
  orderTrendMetricTiles,
  type TrendMetricTile,
  type OrderableTile,
} from "@/lib/trend-metrics";
import type { BodyCardId } from "@/lib/trends-card-rank";

// The Trends → Overview → body census sparkline-tile overview (#1067 Phase 2) — the default view on
// mobile. Each present metric renders as a compact selected-range sparkline + latest
// value and delta tile (the pillars-widget grammar, via the shared TrendMiniCard) that opens
// its per-metric detail page; absent metrics don't render. Sleep uses the same chart
// tile grammar but links to the dedicated /sleep page, because strong topics keep
// their own surface (#1042). The tiles are the SAME series the classic chart stack
// draws, windowed by the shared Trends range — one gather feeds both (#221).

export interface SpecialBodyTile {
  slug: string;
  id: BodyCardId;
  label: string;
  present: boolean;
  empty?: boolean;
  node: ReactNode;
}

export default function TrendMetricTiles({
  tiles,
  growth,
  sleep,
  order,
}: {
  tiles: TrendMetricTile[];
  // Composite growth-percentile chart; null outside pediatric chart eligibility.
  growth: SpecialBodyTile[];
  // The Sleep chart tile links to /sleep and is ordered with the metric tiles.
  // Null when the profile has no sleep data.
  sleep: SpecialBodyTile | null;
  // The tab's ranked card order (#1490) — the SAME sequence the chart stack and the
  // jump chips read, so the two view modes can never disagree about what leads.
  order: readonly BodyCardId[];
}) {
  // Merge the metric tiles + the Sleep tile into ONE list ordered by the tab's card
  // order — the same sequence the chart stack + jump chips use.
  const nodeBySlug = new Map<string, ReactNode>();
  const descriptors: OrderableTile[] = tiles.map((t) => {
    nodeBySlug.set(t.slug, renderMetricTile(t));
    return {
      slug: t.slug,
      id: t.slug,
      label: t.label,
      present: t.present,
      empty: t.points.length === 0,
    };
  });
  const addSpecial = (tile: SpecialBodyTile | null) => {
    if (!tile) return;
    nodeBySlug.set(tile.slug, tile.node);
    descriptors.push({
      slug: tile.slug,
      id: tile.id,
      label: tile.label,
      present: tile.present,
      empty: tile.empty,
    });
  };
  // All four percentile tiles share the ranker's `growth` position and retain
  // their clinical order inside it. Sleep has its own base position.
  growth.forEach(addSpecial);
  addSpecial(sleep);
  const ordered = orderTrendMetricTiles(descriptors, order);

  if (ordered.length === 0) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No body-metric data yet. Log one above, or connect a device on the Data
        page.
      </div>
    );
  }

  return (
    <div
      className="grid auto-rows-fr grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3"
      data-testid="body-metric-tiles"
    >
      {ordered.map((d) => (
        <div key={d.slug} className="h-full *:h-full">
          {nodeBySlug.get(d.slug)}
        </div>
      ))}
    </div>
  );
}

function renderMetricTile(t: TrendMetricTile): ReactNode {
  return (
    <TrendMiniCard
      title={t.title}
      mobileTitle={t.label}
      href={t.href}
      data={t.points}
      unit={t.unit}
      color={t.color}
      decimals={t.decimals}
      gapFill={t.gapFill}
      testid={`body-tile-${t.slug}`}
    />
  );
}
