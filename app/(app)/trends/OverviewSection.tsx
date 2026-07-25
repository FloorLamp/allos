import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getTrendPins } from "@/lib/settings";
import {
  buildMetricSeries,
  buildBiomarkerSeries,
  placeholderBiomarkerTile,
  listCompareOptions,
  type TrendSeries,
} from "@/lib/trends-series";
import { bioPinName, isPinned, partitionPinned } from "@/lib/trend-pins";
import type { DateRange } from "@/lib/timeline-format";
import TrendMiniCard from "@/components/TrendMiniCard";
import PinToggle from "@/components/PinToggle";
import PinBiomarkerPicker from "@/components/PinBiomarkerPicker";
import TrendingDigest from "./TrendingDigest";

// The Trends hub's Overview: the "what's trending" digest, then an at-a-glance
// grid of the profile's key trend mini-charts under the shared window. Phase 2
// adds pin-to-Trends — the profile's pinned tiles (standard metrics + any pinned
// biomarker) render FIRST and persist across sessions (per-profile trend_pins);
// the rest keep their default order.
//
// #1455 B: the StarredBiomarkers status card USED to sit between the digest and
// the grid. It's gone from here (unchanged atop Results → Biomarkers, its one
// remaining card surface). Two curation systems collided on this one page —
// starred (`starred_biomarkers`, the app-wide latest-value-vs-range STATUS lens)
// and pinned (`trend_pins`, the Trends-only grid ORDERING store, the only way a
// biomarker earns a chart tile here) — so a starred-AND-pinned biomarker rendered
// twice in two tile styles, and a starred marker with no readings rendered a dead
// tile. Trends is the charts surface; dropping the card resolves the collision
// with no store or schema change (both stores keep their exact semantics), and
// puts the first chart inside the opening viewport on a phone.
export default async function OverviewSection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const restricted = isTrainingRestricted(profile.id);
  const pins = getTrendPins(profile.id);

  // Tiles = the standard metric series (always) + a tile for each PINNED
  // biomarker (biomarkers only appear as tiles once pinned; add them via the
  // picker below). Then order pinned-first.
  const metricTiles = buildMetricSeries(
    profile.id,
    login.id,
    range,
    restricted
  );
  const pinnedBioTiles: TrendSeries[] = [];
  for (const key of pins) {
    const name = bioPinName(key);
    if (!name) continue;
    // Always render a tile for a pinned biomarker — even with no readings in this
    // window — so its unpin control is reachable regardless of the range. An empty
    // placeholder tile carries the PinToggle and shows TrendMiniCard's empty state.
    const s = buildBiomarkerSeries(profile.id, name, range);
    pinnedBioTiles.push(s ?? placeholderBiomarkerTile(name));
  }
  const tiles = [...metricTiles, ...pinnedBioTiles];
  const { pinned, unpinned } = partitionPinned(tiles, (t) => t.key, pins);

  const hasAny = tiles.some((t) => t.points.length > 0);

  // Biomarkers offered by the picker: those in use that aren't already pinned.
  const bioOptions = listCompareOptions(
    profile.id,
    restricted
  ).biomarkers.filter((o) => !isPinned(pins, o.key));

  const renderTile = (t: TrendSeries) => (
    <TrendMiniCard
      key={t.key}
      title={t.label}
      href={t.href}
      data={t.points}
      label={t.label}
      unit={t.unit}
      color={t.color}
      decimals={t.decimals}
      range={t.range}
      minPctChange={t.minPctChange}
      applyBiomarkerDomain={t.kind === "biomarker"}
      footer={<PinToggle pinKey={t.key} pinned={isPinned(pins, t.key)} />}
    />
  );

  return (
    <div className="space-y-6">
      <TrendingDigest range={range} />

      {pinned.length > 0 && (
        <div className="space-y-3">
          <h2 className="flex items-center gap-2 section-label">Pinned</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {pinned.map(renderTile)}
          </div>
        </div>
      )}

      {hasAny ? (
        unpinned.length > 0 && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {unpinned.map(renderTile)}
          </div>
        )
      ) : (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          No body-metric or training data in this range. Pin a biomarker below,
          or widen the date range.
        </div>
      )}

      <PinBiomarkerPicker options={bioOptions} />
    </div>
  );
}
