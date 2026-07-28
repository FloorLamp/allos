// Server-side series assembly for the Trends hub Phase 2. Builds the
// named, date-keyed numeric series that the Compare overlay, the "what's trending"
// digest, and the pinned Overview tiles all consume, so each surface shapes its
// data ONE way. This is a server helper (it reads via the profile-scoped queries
// and resolves units at the boundary) — the pure math lives in lib/trends-compare,
// lib/trends-digest, and lib/trend-pins. No `.prepare` here: every read goes
// through an already profile-scoped query, so the scoping guard is unaffected.

import {
  getLogicalBodyMetricDailySeries,
  getVolumeByDate,
  getBiomarkerSeriesWithDerived,
  getUsedCanonicalNamesWithDerived,
  getCanonicalBiomarker,
  getMedicationCourses,
  getSupplements,
  getAppointments,
  getProtocolWindows,
} from "./queries";
import { bodyMetricKindForBiomarker } from "./outcome-identity";
import {
  getUnitPrefs,
  getUserSex,
  getUserAge,
  getUserAgeOn,
  getUserReproductiveStatus,
  getSituationEvents,
} from "./settings";
import { showBodyFat } from "./growth-metrics";
import {
  buildAnnotations,
  buildProtocolWindows,
  type TrendAnnotation,
  type TrendWindow,
} from "./trend-annotations";
import { dispWeight, round } from "./units";
import {
  referenceRange,
  parseReferenceRange,
  parseLooseValue,
} from "./reference-range";
import { convertToCanonical, sameUnit } from "./unit-conversions";
import {
  ALL_ROWS,
  filterSeriesByRange,
  outOfWindowAgeLabel,
  outOfWindowLatest,
} from "./trends";
import { bioSeriesKey, metricSeriesKey } from "./saved-items";
import { bioColor } from "./trend-colors";
import type { DateRange } from "./timeline-format";
import { biomarkerViewHref, type AppRoute } from "./hrefs";

export interface TrendSeries {
  key: string; // "metric:weight" | "bio:LDL Cholesterol" — also the pin key
  label: string;
  // Display-unit suffix used in captions/tiles ("%", " bpm", " kg", " mg/dL"), or
  // "" when the metric has none.
  unit: string;
  color: string;
  href: AppRoute;
  kind: "metric" | "biomarker";
  decimals: number;
  // Windowed, chronological (oldest → newest), non-null points in the series' own
  // unit (canonical unit for a biomarker with one, display unit for metrics).
  points: { date: string; value: number }[];
  // Plain [low, high] reference range in the SAME unit as `points`, when known —
  // lets the digest classify a move as crossing into/out of range. null for
  // metrics and biomarkers without a resolvable range.
  range: { low: number | null; high: number | null } | null;
  // Optional metric-aware "trending" threshold (fraction) for the digest (#37):
  // 2% is a real weight move but noise for training volume. Read by summarizeTrends
  // as DigestSeries.minPctChange; undefined falls back to the digest default.
  minPctChange?: number;
  // The sparse-series fallback (#1485 G), set ONLY when `points` is empty and the
  // series has history behind the window: the latest reading, pre-formatted in the
  // series' own unit, with the age label that marks it as outside the window. Never
  // a plottable point — a renderer must show it AS a stale value (text + age), never
  // draw it on the line, or the tile claims a five-month-old number is current.
  outsideWindow?: {
    date: string;
    text: string;
    age: string;
  } | null;
}

export interface TrendOption {
  key: string;
  label: string;
  kind: "metric" | "biomarker";
}

// Deterministic biomarker colors live in the pure lib/trend-colors module (no DB
// imports) so the Compare color logic stays unit-testable; re-exported here so
// existing import sites keep working (bioColor is also imported above for local
// use, since a re-export alone doesn't bind it in module scope).
export { deCollideColor, BIO_COLORS } from "./trend-colors";

interface MetricDef {
  id: string; // "weight" — the metricPinKey suffix
  label: string;
  unit: string;
  color: string;
  href: AppRoute;
  decimals: number;
  restricted?: boolean; // a training surface (hidden for age-restricted profiles)
  // Metric-aware digest "trending" threshold (#37); omitted → digest default
  // (0.05). Weight barely moves in percent so a low bar is right; volume is
  // spiky day-to-day so it needs a high one.
  minPctChange?: number;
}

// The standard Overview metric tiles, in their default (unpinned) order.
const METRIC_DEFS: MetricDef[] = [
  {
    id: "weight",
    label: "Weight",
    unit: "",
    color: "#16a34a",
    href: "/trends?tab=body",
    decimals: 1,
    minPctChange: 0.02, // a 2% weight change is already meaningful
  },
  {
    id: "bodyfat",
    label: "Body fat",
    unit: "%",
    color: "#a855f7",
    href: "/trends?tab=body",
    decimals: 1,
    // default 0.05
  },
  {
    id: "resting_hr",
    label: "Resting heart rate",
    unit: " bpm",
    color: "#fb923c",
    href: "/trends?tab=body",
    decimals: 0,
    minPctChange: 0.05, // resting HR is fairly stable; 5% is a genuine shift
  },
  {
    id: "volume",
    label: "Training volume",
    unit: "",
    color: "#0ea5e9",
    href: "/training",
    decimals: 0,
    restricted: true,
    minPctChange: 0.15, // training volume swings hugely session-to-session
  },
];

// Build the standard body/training metric series (weight, body fat, resting HR,
// training volume) windowed to `range`, in the login's display units. Volume is a
// training surface, so it's dropped for age-restricted profiles.
export function buildMetricSeries(
  profileId: number,
  loginId: number,
  range: DateRange,
  restricted: boolean
): TrendSeries[] {
  const wu = getUnitPrefs(loginId).weightUnit;
  const weightUnitSuffix = ` ${wu}`;
  // Body fat % is not a datapoint we surface for children (kids growth trends) —
  // drop its tile for a minor, matching the Body tab's age-aware layout.
  const hideBodyFat = !showBodyFat(getUserAge(profileId));

  const pointsFor = (id: string): { date: string; value: number }[] => {
    switch (id) {
      // Weight / body-fat / resting-HR all read through the logical series: the
      // one-source-per-day body_metrics data the Body tab charts (#14/#395), plus
      // legacy medical-record dates only when body_metrics has no value. A
      // two-device day therefore can't double back the line. Series is already
      // oldest→newest in canonical units.
      case "weight":
        return getLogicalBodyMetricDailySeries(
          profileId,
          "weight",
          ALL_ROWS
        ).map((p) => ({ date: p.date, value: dispWeight(p.value, wu) }));
      case "bodyfat":
        return getLogicalBodyMetricDailySeries(
          profileId,
          "body_fat",
          ALL_ROWS
        ).map((p) => ({ date: p.date, value: round(p.value, 1) }));
      case "resting_hr":
        return getLogicalBodyMetricDailySeries(
          profileId,
          "resting_hr",
          ALL_ROWS
        ).map((p) => ({ date: p.date, value: Math.round(p.value) }));
      case "volume":
        return getVolumeByDate(profileId).map((v) => ({
          date: v.date,
          value: dispWeight(v.volume, wu, 0),
        }));
      default:
        return [];
    }
  };

  return METRIC_DEFS.filter(
    (d) => !(d.restricted && restricted) && !(d.id === "bodyfat" && hideBodyFat)
  ).map((d) => ({
    key: metricSeriesKey(d.id),
    label: d.label,
    unit: d.id === "weight" || d.id === "volume" ? weightUnitSuffix : d.unit,
    color: d.color,
    href: d.href,
    kind: "metric" as const,
    decimals: d.decimals,
    points: filterSeriesByRange(pointsFor(d.id), range),
    range: null,
    minPctChange: d.minPctChange,
  }));
}

// One biomarker's FULL (un-windowed) plot: the numeric points in the unit the tile
// and chart will label, plus the effective reference range. Mirrors the biomarker
// detail page's charting: chart in the canonical unit when the biomarker has one
// (converting every convertible reading and carrying the effective reference
// range), else fall back to the latest reading's unit and its parsed lab range.
// Censored readings ("<0.10") are plotted at their limit.
//
// Extracted from buildBiomarkerSeries (#1485 G) so the windowed chart and the
// sparse-series fallback resolve unit + conversion through the SAME path — a
// fallback that formatted the raw stored value would print a different unit than
// the tile's own chart for exactly the analytes it exists to serve.
function biomarkerPlot(
  profileId: number,
  canonical: string
): {
  rows: ReturnType<typeof getBiomarkerSeriesWithDerived>;
  points: { date: string; value: number }[];
  unit: string | null;
  rng: { low: number | null; high: number | null } | null;
} | null {
  const series = getBiomarkerSeriesWithDerived(profileId, canonical);
  if (series.length === 0) return null;
  const cb = getCanonicalBiomarker(canonical);
  const sex = getUserSex(profileId);
  const latestDate = series[series.length - 1]?.date ?? null;
  const age = getUserAgeOn(profileId, latestDate);
  const status = getUserReproductiveStatus(profileId);

  // exact value_num, or an inexact-but-bounded reading plotted at its limit.
  const plottable = series.flatMap((r) => {
    const p =
      r.value_num != null ? { value: r.value_num } : parseLooseValue(r.value);
    return p ? [{ r, value: p.value }] : [];
  });

  let unit: string | null;
  let points: { date: string; value: number }[];
  let rng: { low: number | null; high: number | null } | null = null;

  if (cb && cb.unit) {
    unit = cb.unit;
    points = plottable
      .map((x) => ({
        date: x.r.date,
        value: convertToCanonical(x.value, x.r.unit, cb),
      }))
      .filter((x): x is { date: string; value: number } => x.value != null);
    const ref = referenceRange(cb, sex, age, status);
    if (ref.low != null || ref.high != null) {
      rng = { low: ref.low, high: ref.high };
    }
  } else {
    const latestUnit = plottable.length
      ? (plottable[plottable.length - 1].r.unit ?? null)
      : null;
    unit = latestUnit;
    points = plottable
      .filter((x) => sameUnit(x.r.unit, latestUnit))
      .map((x) => ({ date: x.r.date, value: x.value }));
    const parsed = parseReferenceRange(
      series[series.length - 1].reference_range
    );
    if (parsed) rng = { low: parsed.low ?? null, high: parsed.high ?? null };
  }

  return { rows: series, points, unit, rng };
}

// Build one biomarker's series windowed to `range`. Returns null when there are no
// numeric readings to chart IN THAT WINDOW — the contract Compare and the digest
// read (an empty overlay/chip is correct for both). The Overview tile takes the
// sparse-aware path below instead.
export function buildBiomarkerSeries(
  profileId: number,
  canonical: string,
  range: DateRange
): TrendSeries | null {
  const plot = biomarkerPlot(profileId, canonical);
  if (!plot) return null;

  const windowed = filterSeriesByRange(plot.points, range);
  if (windowed.length === 0) return null;

  return {
    key: bioSeriesKey(canonical),
    label: canonical,
    unit: plot.unit ? ` ${plot.unit}` : "",
    color: bioColor(canonical),
    href: biomarkerViewHref(canonical),
    kind: "biomarker",
    decimals: 1,
    points: windowed,
    range: plot.rng,
  };
}

const BIO_TILE_DECIMALS = 1;

// How an out-of-window reading prints on a tile. Numeric readings go through the
// SAME unit the chart would have labelled; a reading with no numeric value at all
// (a genotype like "e3/e4" — starred, and real in the seed) prints its stored text
// with its own unit, because "the latest reading" is still the honest answer for a
// qualitative analyte even though nothing can be plotted.
function outOfWindowText(
  point: { date: string; value: number } | null,
  row: { date: string; value: string | null; unit: string | null } | undefined,
  unit: string | null
): { date: string; text: string } | null {
  if (point && (!row || point.date >= row.date)) {
    return {
      date: point.date,
      text: `${round(point.value, BIO_TILE_DECIMALS)}${unit ? ` ${unit}` : ""}`,
    };
  }
  const raw = row?.value?.trim();
  if (!row || !raw) return null;
  return { date: row.date, text: `${raw}${row.unit ? ` ${row.unit}` : ""}` };
}

// The Overview tile for a SAVED biomarker (#1456: always rendered, so its ★ stays
// reachable at any window). Never null — it resolves to one of three honest states:
//
//   • readings in the window → the real windowed series (identical to
//     buildBiomarkerSeries);
//   • no readings in the window but history behind it → an empty-points tile
//     carrying `outsideWindow`, the latest reading + its age (#1485 G). With 90D as
//     the default window this is the COMMON case for an annual lab, and the old
//     "No data in this range" threw away the one number the user came for;
//   • never measured (or nothing renderable) → the #1456 placeholder, unchanged.
//
// The out-of-window reading is deliberately NOT merged into `points`: it is carried
// beside them so the renderer must mark it as outside the window rather than plot a
// stale value on the line.
export function buildSavedBiomarkerTile(
  profileId: number,
  canonical: string,
  range: DateRange,
  todayStr: string
): TrendSeries {
  const plot = biomarkerPlot(profileId, canonical);
  if (!plot) return placeholderBiomarkerTile(canonical);

  const windowed = filterSeriesByRange(plot.points, range);
  const base: TrendSeries = {
    key: bioSeriesKey(canonical),
    label: canonical,
    unit: plot.unit ? ` ${plot.unit}` : "",
    color: bioColor(canonical),
    href: biomarkerViewHref(canonical),
    kind: "biomarker",
    decimals: BIO_TILE_DECIMALS,
    points: windowed,
    range: plot.rng,
  };
  if (windowed.length > 0) return base;

  // Nothing in the window: fall back to the newest reading behind it. Both the
  // numeric series and the raw rows are consulted — `outOfWindowLatest` gates on
  // the same "no points in this window" question for each, so a qualitative-only
  // analyte still resolves.
  const latestPoint = outOfWindowLatest(plot.points, range);
  const latestRow = outOfWindowLatest(plot.rows, range);
  const reading = outOfWindowText(
    latestPoint,
    latestRow ?? undefined,
    plot.unit
  );
  if (!reading) return { ...base, points: [], unit: base.unit || "" };
  return {
    ...base,
    points: [],
    outsideWindow: {
      date: reading.date,
      text: reading.text,
      age: outOfWindowAgeLabel(reading.date, todayStr),
    },
  };
}

// An empty-points placeholder tile for a PINNED biomarker that has no readings in
// the selected window (buildBiomarkerSeries returns null there). Rendering this
// keeps the pinned tile — and its unpin control — on screen regardless of the
// window, so a pin is never left un-unpinnable. Same key/href/color as the real
// tile so it slots into the Pinned section and TrendMiniCard shows its empty state.
export function placeholderBiomarkerTile(canonical: string): TrendSeries {
  return {
    key: bioSeriesKey(canonical),
    label: canonical,
    unit: "",
    color: bioColor(canonical),
    href: biomarkerViewHref(canonical),
    kind: "biomarker",
    decimals: 1,
    points: [],
    range: null,
  };
}

// The pickable Compare options: the standard metrics plus every biomarker that has
// stored readings (canonical names in use). Series are built lazily by
// resolveSeriesByKey so listing stays cheap.
export function listCompareOptions(
  profileId: number,
  restricted: boolean
): { metrics: TrendOption[]; biomarkers: TrendOption[] } {
  const hideBodyFat = !showBodyFat(getUserAge(profileId));
  const metrics = METRIC_DEFS.filter(
    (d) => !(d.restricted && restricted) && !(d.id === "bodyfat" && hideBodyFat)
  ).map((d) => ({
    key: metricSeriesKey(d.id),
    label: d.label,
    kind: "metric" as const,
  }));
  const biomarkers = getUsedCanonicalNamesWithDerived(profileId)
    .filter((name) => bodyMetricKindForBiomarker(name) == null)
    .map((name) => ({
      key: bioSeriesKey(name),
      label: name,
      kind: "biomarker" as const,
    }));
  return { metrics, biomarkers };
}

// Resolve a single series by its key ("metric:…" or "bio:…"), windowed to `range`.
// Returns null for an unknown/empty key or a series with no points in the window.
export function resolveSeriesByKey(
  profileId: number,
  loginId: number,
  range: DateRange,
  key: string,
  restricted: boolean
): TrendSeries | null {
  if (key.startsWith("metric:")) {
    const metrics = buildMetricSeries(profileId, loginId, range, restricted);
    return metrics.find((m) => m.key === key) ?? null;
  }
  if (key.startsWith("bio:")) {
    return buildBiomarkerSeries(profileId, key.slice("bio:".length), range);
  }
  return null;
}

// Assemble the event-annotation markers for the Trends charts,
// windowed to `range`: medication course start/stop, scheduled/completed
// appointments, and active-situation changes. Every source read goes through an
// already PROFILE-SCOPED query (getMedicationCourses / getSupplements /
// getAppointments) or the per-profile situation-event log (getSituationEvents), so
// no owned SQL is added here; the pure lib/trend-annotations does the shaping. None
// of these sources is training-derived, so they're safe for restricted profiles.
export function buildTrendAnnotations(
  profileId: number,
  range: DateRange
): TrendAnnotation[] {
  // Medication courses carry only item_id; resolve names from the item list.
  const names = new Map<number, string>();
  for (const s of getSupplements(profileId)) names.set(s.id, s.name);
  const medications = getMedicationCourses(profileId).map((c) => ({
    name: names.get(c.item_id) ?? "Medication",
    startedOn: c.started_on,
    stoppedOn: c.stopped_on,
  }));
  const appointments = getAppointments(profileId)
    // A cancelled visit never happened — don't mark it as an event.
    .filter((a) => a.status !== "cancelled")
    .map((a) => ({
      date: a.scheduled_at.slice(0, 10),
      title: a.title,
      providerName: a.provider_name,
    }));
  const situations = getSituationEvents(profileId);
  return buildAnnotations({ medications, appointments, situations }, range);
}

// The protocol intervention WINDOWS for the Trends charts (issue #660), windowed to
// `range`. Every protocol the profile runs is shaded on the Body/Compare charts —
// matching how the point annotations (medications/appointments) show regardless of
// which metric is charted; the per-analyte biomarker chart narrows to the targeting
// protocol instead. Reads only the profile-scoped getProtocolWindows.
export function buildProtocolTrendWindows(
  profileId: number,
  range: DateRange
): TrendWindow[] {
  return buildProtocolWindows(getProtocolWindows(profileId), range);
}

// Assemble every candidate series for the "what's trending" digest: the standard
// metrics plus each biomarker in use. Biomarkers carry their reference range so a
// move can be classified as crossing into/out of range.
export function buildDigestSeries(
  profileId: number,
  loginId: number,
  range: DateRange,
  restricted: boolean
): TrendSeries[] {
  const out = buildMetricSeries(profileId, loginId, range, restricted);
  for (const name of getUsedCanonicalNamesWithDerived(profileId)) {
    if (bodyMetricKindForBiomarker(name) != null) continue;
    const s = buildBiomarkerSeries(profileId, name, range);
    if (s) out.push(s);
  }
  return out;
}
