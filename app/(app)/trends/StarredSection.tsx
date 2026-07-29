import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getSavedItems } from "@/lib/queries/saved";
import {
  buildMetricSeries,
  buildSavedBodyMetricSeries,
  buildSavedBiomarkerTile,
  listCompareOptions,
  type TrendSeries,
} from "@/lib/trends-series";
import { today } from "@/lib/db";
import { formatMonthDay } from "@/lib/format-date";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  isSeriesKeySaved,
  metricSeriesKey,
  partitionOverviewTiles,
} from "@/lib/saved-items";
import { sparklineShapeForSeriesKey } from "@/lib/trend-sparkline";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState } from "@/components/ui";
import TrendMiniCard from "@/components/TrendMiniCard";
import TrendTileMenu from "@/components/TrendTileMenu";
import SaveTrendPicker from "@/components/SaveTrendPicker";
import SavedTilesGrid, {
  type SavedTileItem,
} from "@/components/SavedTilesGrid";

// The Trends hub's STARRED GRID — the profile's OWN cross-domain grid of trend
// mini-charts under the shared window.
//
// #1644 merged the tabs into one page and split this section from the "what's
// trending" digest that used to share the Overview tab with it: the digest is the
// page head, this is the curation surface directly under it, and the per-domain
// censuses follow as their own sections. The grid's contract is UNCHANGED and is
// now the only place it applies — the "nothing renders unconditionally" rule
// belongs to this section, while the censuses below render always, as their tabs
// did.
//
// #1487 — WHAT THIS GRID IS FOR. It answers: what you saved, and what changed. The
// domain censuses show everything; the starred grid shows nothing
// unconditionally. Until that landed the grid was three things — the movers digest,
// the saved tiles (#1456), and a hardcoded SAMPLER: the four standard metric tiles
// (weight, body fat, resting HR, training volume) rendered whether or not the user
// cared, duplicating the domain censuses at tile zoom. That third part is what made
// Overview and the tabs feel like the same page twice.
//
// The sampler is gone. Those four are now real `saved_items` rows — seeded at
// profile creation and, for the installed base, by migration 114 (#1487's data half,
// lib/standard-metric-seeds.ts) — so day-one appearance is IDENTICAL and the change
// is that the tiles are now REMOVABLE. One star answers "what's in my starred grid"
// for every kind; SaveTrendPicker (metrics AND biomarkers) is the way back.
//
// #1456 remains the store: ONE ★ behind ONE table (`saved_items`). A saved biomarker
// simultaneously earns the Results status card, a tile here, and passport inclusion.
//
// Two rules the grid must not break:
//   • A saved ref with NO tile is SKIPPED, never rendered empty — the age gates are a
//     render-time filter (buildMetricSeries drops training volume for a restricted
//     profile, body fat below the growth-metrics age), and the seed set is the same
//     for every profile. A gated metric is simply absent, exactly as before.
//   • A saved item with a tile but NOTHING TO SHOW still renders, so its unstar
//     control stays reachable at any window (#1456). #1485 A compacts those to a
//     one-line row and sinks them below the populated tiles, which is where the
//     ~600px of mid-grid whitespace went.
export default async function StarredSection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const restricted = isTrainingRestricted(profile.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  // The profile's today, for the age label on a sparse tile's out-of-window
  // reading (#1485 G) — profile timezone, never the server's local day.
  const todayStr = today(profile.id);
  // The profile's saved set, in canonical saved order (explicit positions first, then
  // newest star first). This is now the MEMBERSHIP list, not just an ordering.
  const savedRefs = getSavedItems(profile.id).map((s) => ({
    kind: s.kind,
    key: s.key,
  }));

  // One tile per saved ref, in saved order. Metrics resolve against the age-gated
  // series set (a gated metric yields no tile and is skipped); a saved biomarker
  // always resolves — buildSavedBiomarkerTile answers with a windowed series, the
  // #1485 G sparse fallback (latest reading + age), or an empty placeholder.
  const metricByKey = new Map(
    buildMetricSeries(profile.id, login.id, range, restricted).map((t) => [
      t.key,
      t,
    ])
  );
  const tiles: TrendSeries[] = [];
  for (const ref of savedRefs) {
    if (ref.kind === "trend-metric") {
      const tile =
        metricByKey.get(metricSeriesKey(ref.key)) ??
        buildSavedBodyMetricSeries(
          profile.id,
          login.id,
          ref.key,
          range,
          todayStr
        );
      if (tile) tiles.push(tile);
    } else {
      tiles.push(buildSavedBiomarkerTile(profile.id, ref.key, range, todayStr));
    }
  }

  // #1485 A: which tiles compact to a one-line row and sink below the grid. It is a
  // LAYOUT split only — every tile keeps its slot in the SAVED order, which is the
  // list both reorder affordances (the #1485 C drag and the ⋯ menu's arrows) move
  // within, so sinking an empty tile changes where it draws, never what its position
  // means. The split itself is applied client-side by SavedTilesGrid, over the same
  // pure predicate, so an optimistic drag re-splits without a round trip.
  const emptyKeys = new Set(
    partitionOverviewTiles(tiles).empty.map((t) => t.tile.key)
  );

  // What the picker can still add: everything savable that isn't saved yet — metrics
  // included, since unstarring one now removes its tile and the picker is the way
  // back (see components/SaveTrendPicker.tsx). listCompareOptions applies the same
  // age gates as the tile builder, so a restricted profile is never offered training
  // volume.
  const options = listCompareOptions(profile.id, restricted);
  const unsaved = (o: { key: string }) => !isSeriesKeySaved(savedRefs, o.key);

  const renderTile = (t: TrendSeries, compact: boolean) => (
    <TrendMiniCard
      title={t.label}
      mobileTitle={t.shortLabel}
      href={t.href}
      data={t.points}
      unit={t.unit}
      color={t.color}
      decimals={t.decimals}
      range={t.range}
      minPctChange={t.minPctChange}
      applyBiomarkerDomain={t.kind === "biomarker"}
      outsideWindow={t.outsideWindow ?? null}
      readingDateLabel={(() => {
        const readingDate =
          t.outsideWindow?.date ??
          (t.points.length === 1 ? t.points[0].date : null);
        return readingDate
          ? formatMonthDay(readingDate, formatPrefs)
          : undefined;
      })()}
      // #1485 D: the mark follows the job. Decided once, from the series key, by
      // lib/trend-sparkline.ts — training volume's rest days are real zeros, so a
      // line through them draws a slope over training that never happened.
      sparklineShape={sparklineShapeForSeriesKey(t.key)}
      compact={compact}
      // The tile's own controls. Its reorder items resolve their list from the
      // grid's context (#1485 C), so nothing about ordering is computed here.
      menu={<TrendTileMenu itemKey={t.key} label={t.label} />}
    />
  );

  // One item per tile, IN SAVED ORDER — the list the drag moves within. The node is
  // fully server-rendered here and handed to the client grid as a prop, so a
  // reorder is pure motion: no re-query, no client-side tile rendering.
  const items: SavedTileItem[] = tiles.map((t) => ({
    key: t.key,
    empty: emptyKeys.has(t.key),
    node: renderTile(t, emptyKeys.has(t.key)),
  }));

  return (
    <div className="space-y-6">
      {items.length > 0 ? (
        <SavedTilesGrid items={items} />
      ) : (
        // Everything unstarred (or a brand-new profile whose only saved metrics are
        // age-gated): the grid is genuinely empty, so it says so and offers the way
        // back rather than rendering a blank page.
        <EmptyState message="Star metrics and biomarkers to build your grid." />
      )}

      <SaveTrendPicker
        metrics={options.metrics.filter(unsaved)}
        biomarkers={options.biomarkers.filter(unsaved)}
      />
    </div>
  );
}
