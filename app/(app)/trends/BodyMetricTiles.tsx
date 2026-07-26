import type { ReactNode } from "react";
import TrendMiniCard from "@/components/TrendMiniCard";
import {
  orderBodyMetricTiles,
  type BodyMetricTile,
  type OrderableTile,
} from "@/lib/trends-body-metrics";
import type { BodyCardId } from "@/lib/trends-card-rank";

// The Trends → Body sparkline-tile overview (#1067 Phase 2) — the default view on
// mobile. Each present metric renders as a compact sparkline + latest value + 30-day
// delta tile (the pillars-widget grammar, via the shared TrendMiniCard) that opens
// its per-metric detail page; absent metrics don't render. Sleep is a SPECIAL tile —
// it links to the dedicated /sleep page, not a metric page, because strong topics
// keep their own surface (#1042). The tiles are the SAME series the classic chart
// stack draws, just their 30-day tails — one gather feeds both (#221).

export interface SleepTile {
  present: boolean;
  latestDate: string | null;
  node: ReactNode;
}

export default function BodyMetricTiles({
  tiles,
  sleep,
  order,
}: {
  tiles: BodyMetricTile[];
  // The bespoke Sleep tile (duration + regularity, linking to /sleep), ordered in
  // with the metric tiles. Null when the profile has no sleep data.
  sleep: SleepTile | null;
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
    };
  });
  if (sleep) {
    nodeBySlug.set("sleep", sleep.node);
    // Sleep's base position (just ahead of the synced daily metrics, after the
    // vitals + composition + growth block) is declared once in BODY_CARD_LAYOUT
    // now, not re-numbered per surface.
    descriptors.push({
      slug: "sleep",
      id: "sleep",
      label: "Sleep",
      present: sleep.present,
    });
  }
  const ordered = orderBodyMetricTiles(descriptors, order);

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
      className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3"
      data-testid="body-metric-tiles"
    >
      {ordered.map((d) => (
        <div key={d.slug}>{nodeBySlug.get(d.slug)}</div>
      ))}
    </div>
  );
}

function renderMetricTile(t: BodyMetricTile): ReactNode {
  return (
    <TrendMiniCard
      title={t.label}
      href={t.href}
      data={t.points}
      label={t.label}
      unit={t.unit}
      color={t.color}
      decimals={t.decimals}
      testid={`body-tile-${t.slug}`}
    />
  );
}
