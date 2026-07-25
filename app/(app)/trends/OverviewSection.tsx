import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getSavedItems } from "@/lib/queries/saved";
import {
  buildMetricSeries,
  buildSavedBiomarkerTile,
  listCompareOptions,
  type TrendSeries,
} from "@/lib/trends-series";
import { today } from "@/lib/db";
import { isSeriesKeySaved, partitionSaved } from "@/lib/saved-items";
import type { DateRange } from "@/lib/timeline-format";
import TrendMiniCard from "@/components/TrendMiniCard";
import StarButton from "@/components/StarButton";
import SavedReorder from "@/components/SavedReorder";
import SaveBiomarkerPicker from "@/components/SaveBiomarkerPicker";
import TrendingDigest from "./TrendingDigest";

// The Trends hub's Overview: the "what's trending" digest, then an at-a-glance grid
// of the profile's key trend mini-charts under the shared window.
//
// #1456 — the unified save store. This page used to read `trend_pins`, a Trends-only
// ORDERING store that was ALSO the only way a biomarker earned a chart tile here,
// while the star store (`starred_biomarkers`) separately drove the Results status card
// and the passport summary. Two gestures answered one question, and the two sets
// diverged. Both are now ONE `saved_items` table behind the ★ star:
//
//   • Saved BIOMARKERS get a chart tile here — the same star that lights the Results
//     status card and puts the analyte in the passport summary. No second gesture.
//   • Saved METRICS are PROMOTED (ordered first); every metric tile renders either
//     way, because for a standard metric a save is ordering, not visibility.
//   • Ordering within the saved row is the SavedReorder affordance (`position`), which
//     replaced PinToggle. Un-starring is the same ★ button that saved it.
//
// #1455 B: the StarredBiomarkers status card USED to sit between the digest and the
// grid; it's gone from here (unchanged atop Results → Biomarkers, its one remaining
// card surface) — a starred biomarker's presence on Trends is its CHART tile.
export default async function OverviewSection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const restricted = isTrainingRestricted(profile.id);
  // The profile's today, for the age label on a sparse tile's out-of-window
  // reading (#1485 G) — profile timezone, never the server's local day.
  const todayStr = today(profile.id);
  // The profile's saved set, in canonical saved order (explicit positions first, then
  // newest star first) — the ONE ordering both halves of the grid read.
  const savedRefs = getSavedItems(profile.id).map((s) => ({
    kind: s.kind,
    key: s.key,
  }));

  // Tiles = the standard metric series (always) + a tile for each SAVED biomarker
  // (a biomarker earns a tile by being starred — here, on its detail page, or via the
  // picker below). Then order saved-first.
  const metricTiles = buildMetricSeries(
    profile.id,
    login.id,
    range,
    restricted
  );
  const savedBioTiles: TrendSeries[] = [];
  for (const ref of savedRefs) {
    if (ref.kind !== "biomarker") continue;
    // Always render a tile for a saved biomarker — even with no readings in this
    // window — so its ★ control is reachable regardless of the range (#1456).
    // buildSavedBiomarkerTile resolves the three cases: a windowed series, the
    // #1485 G sparse fallback (latest reading + age), or the empty placeholder for
    // a never-measured analyte.
    savedBioTiles.push(
      buildSavedBiomarkerTile(profile.id, ref.key, range, todayStr)
    );
  }
  const tiles = [...metricTiles, ...savedBioTiles];
  const { saved: savedTiles, unsaved } = partitionSaved(
    tiles,
    (t) => t.key,
    savedRefs
  );

  const hasAny = tiles.some((t) => t.points.length > 0);

  // Biomarkers offered by the picker: those in use that aren't already saved.
  const bioOptions = listCompareOptions(
    profile.id,
    restricted
  ).biomarkers.filter((o) => !isSeriesKeySaved(savedRefs, o.key));

  // `index` is the tile's slot in the SAVED row (undefined for an unsaved tile), so
  // the reorder ends are computed over the tiles ACTUALLY rendered rather than the raw
  // saved set — a saved metric the age gate removed has no tile, and the first
  // rendered tile is the one whose "move earlier" is disabled.
  const renderTile = (t: TrendSeries, index?: number) => (
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
      outsideWindow={t.outsideWindow ?? null}
      footer={
        <span className="flex flex-wrap items-center gap-2">
          <StarButton
            itemKey={t.key}
            saved={index != null}
            compact
            label={t.label}
          />
          {index != null && (
            <SavedReorder
              itemKey={t.key}
              isFirst={index === 0}
              isLast={index === savedTiles.length - 1}
              label={t.label}
            />
          )}
        </span>
      }
    />
  );

  return (
    <div className="space-y-6">
      <TrendingDigest range={range} />

      {savedTiles.length > 0 && (
        <div className="space-y-3" data-testid="saved-tiles">
          <h2 className="flex items-center gap-2 section-label">★ Starred</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {savedTiles.map((t, i) => renderTile(t, i))}
          </div>
        </div>
      )}

      {hasAny ? (
        unsaved.length > 0 && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {unsaved.map((t) => renderTile(t))}
          </div>
        )
      ) : (
        <div className="card text-sm text-slate-500 dark:text-slate-400">
          No body-metric or training data in this range. Star a biomarker below,
          or widen the date range.
        </div>
      )}

      <SaveBiomarkerPicker options={bioOptions} />
    </div>
  );
}
