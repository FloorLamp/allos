import type { ReactNode } from "react";
import TrendMiniCard from "@/components/TrendMiniCard";
import {
  orderTrendMetricTiles,
  seriesKeyForBodyCard,
  type TrendMetricTile,
  type OrderableTile,
} from "@/lib/trend-metrics";
import type { BodyCardId } from "@/lib/trends-card-rank";
import TrendTileMenu from "@/components/TrendTileMenu";
import SavedTilesGrid, {
  type SavedTileItem,
} from "@/components/SavedTilesGrid";

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
  pinned,
  structural,
  addTile,
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
  // Saved metric cards, in saved order. Their contiguous run owns the census's
  // drag and arrow reorder controls now that the duplicate Starred grid is gone.
  pinned: readonly BodyCardId[];
  // Life-stage cards that stay ahead of the movable saved run even when saved.
  structural: readonly BodyCardId[];
  // The non-card picker cell that trails every real census tile.
  addTile?: ReactNode;
}) {
  // Merge the metric tiles + the Sleep tile into ONE list ordered by the tab's card
  // order — the same sequence the chart stack + jump chips use.
  const nodeBySlug = new Map<string, ReactNode>();
  const descriptors: OrderableTile[] = tiles.map((t) => {
    const seriesKey = seriesKeyForBodyCard(t.slug);
    const isPinned = pinned.includes(t.slug);
    nodeBySlug.set(
      t.slug,
      renderMetricTile(
        t,
        isPinned && seriesKey ? (
          <TrendTileMenu itemKey={seriesKey} label={t.title} />
        ) : undefined
      )
    );
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
  const ordered = orderTrendMetricTiles(descriptors, order, pinned, structural);

  if (ordered.length === 0 && !addTile) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No body-metric data yet. Log one above, or connect a device on the Data
        page.
      </div>
    );
  }

  const pinnedSet = new Set<BodyCardId>(pinned);
  const items: SavedTileItem[] = ordered.map((descriptor) => {
    const savedKey = seriesKeyForBodyCard(descriptor.id as BodyCardId);
    const isPinned =
      savedKey != null && pinnedSet.has(descriptor.id as BodyCardId);
    return {
      key: isPinned ? savedKey : `card:${descriptor.slug}`,
      pinned: isPinned,
      reorderable:
        isPinned && !structural.includes(descriptor.id as BodyCardId),
      empty: descriptor.empty === true,
      node: nodeBySlug.get(descriptor.slug),
    };
  });

  return <SavedTilesGrid items={items} addTile={addTile} />;
}

function renderMetricTile(t: TrendMetricTile, menu?: ReactNode): ReactNode {
  return (
    <TrendMiniCard
      title={t.title}
      href={t.href}
      data={t.points}
      unit={t.unit}
      color={t.color}
      decimals={t.decimals}
      gapFill={t.gapFill}
      menu={menu}
      testid={`body-tile-${t.slug}`}
    />
  );
}
