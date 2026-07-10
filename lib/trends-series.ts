// Server-side series assembly for the Trends hub Phase 2. Builds the
// named, date-keyed numeric series that the Compare overlay, the "what's trending"
// digest, and the pinned Overview tiles all consume, so each surface shapes its
// data ONE way. This is a server helper (it reads via the profile-scoped queries
// and resolves units at the boundary) — the pure math lives in lib/trends-compare,
// lib/trends-digest, and lib/trend-pins. No `.prepare` here: every read goes
// through an already profile-scoped query, so the scoping guard is unaffected.

import {
  getWeights,
  getBodyMetricsWithSource,
  getVolumeByDate,
  getBiomarkerSeriesWithDerived,
  getUsedCanonicalNamesWithDerived,
  getCanonicalBiomarker,
  getMedicationCourses,
  getSupplements,
  getAppointments,
} from "./queries";
import {
  getUnitPrefs,
  getUserSex,
  getUserAge,
  getUserAgeOn,
  getUserReproductiveStatus,
  getSituationEvents,
} from "./settings";
import { showBodyFat } from "./growth-metrics";
import { buildAnnotations, type TrendAnnotation } from "./trend-annotations";
import { dispWeight, round } from "./units";
import {
  referenceRange,
  parseReferenceRange,
  parseLooseValue,
} from "./reference-range";
import { convertToCanonical, sameUnit } from "./unit-conversions";
import { ALL_ROWS, filterSeriesByRange } from "./trends";
import { bioPinKey, metricPinKey } from "./trend-pins";
import type { DateRange } from "./timeline-format";

export interface TrendSeries {
  key: string; // "metric:weight" | "bio:LDL Cholesterol" — also the pin key
  label: string;
  // Display-unit suffix used in captions/tiles ("%", " bpm", " kg", " mg/dL"), or
  // "" when the metric has none.
  unit: string;
  color: string;
  href: string;
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
}

export interface TrendOption {
  key: string;
  label: string;
  kind: "metric" | "biomarker";
}

// A small deterministic palette so a biomarker gets a stable color across renders.
const BIO_COLORS = [
  "#2563eb",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#db2777",
  "#059669",
  "#ea580c",
];

function bioColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return BIO_COLORS[h % BIO_COLORS.length];
}

interface MetricDef {
  id: string; // "weight" — the metricPinKey suffix
  label: string;
  unit: string;
  color: string;
  href: string;
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
  const bodyMetrics = getBodyMetricsWithSource(profileId, ALL_ROWS);
  // Body fat % is not a datapoint we surface for children (kids growth trends) —
  // drop its tile for a minor, matching the Body tab's age-aware layout.
  const hideBodyFat = !showBodyFat(getUserAge(profileId));

  const pointsFor = (id: string): { date: string; value: number }[] => {
    switch (id) {
      case "weight":
        return getWeights(profileId, ALL_ROWS)
          .slice()
          .reverse()
          .map((w) => ({ date: w.date, value: dispWeight(w.weight_kg, wu) }));
      case "bodyfat":
        return bodyMetrics
          .filter((w) => w.body_fat_pct != null)
          .slice()
          .reverse()
          .map((w) => ({ date: w.date, value: round(w.body_fat_pct!, 1) }));
      case "resting_hr":
        return bodyMetrics
          .filter((w) => w.resting_hr != null)
          .slice()
          .reverse()
          .map((w) => ({ date: w.date, value: Math.round(w.resting_hr!) }));
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
    key: metricPinKey(d.id),
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

// Build one biomarker's series windowed to `range`, mirroring the biomarker detail
// page's charting: chart in the canonical unit when the biomarker has one
// (converting every convertible reading and carrying the effective reference
// range), else fall back to the latest reading's unit and its parsed lab range.
// Censored readings ("<0.10") are plotted at their limit. Returns null when there
// are no numeric readings to chart.
export function buildBiomarkerSeries(
  profileId: number,
  canonical: string,
  range: DateRange
): TrendSeries | null {
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

  const windowed = filterSeriesByRange(points, range);
  if (windowed.length === 0) return null;

  return {
    key: bioPinKey(canonical),
    label: canonical,
    unit: unit ? ` ${unit}` : "",
    color: bioColor(canonical),
    href: `/biomarkers/view?name=${encodeURIComponent(canonical)}`,
    kind: "biomarker",
    decimals: 1,
    points: windowed,
    range: rng,
  };
}

// An empty-points placeholder tile for a PINNED biomarker that has no readings in
// the selected window (buildBiomarkerSeries returns null there). Rendering this
// keeps the pinned tile — and its unpin control — on screen regardless of the
// window, so a pin is never left un-unpinnable. Same key/href/color as the real
// tile so it slots into the Pinned section and TrendMiniCard shows its empty state.
export function placeholderBiomarkerTile(canonical: string): TrendSeries {
  return {
    key: bioPinKey(canonical),
    label: canonical,
    unit: "",
    color: bioColor(canonical),
    href: `/biomarkers/view?name=${encodeURIComponent(canonical)}`,
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
    key: metricPinKey(d.id),
    label: d.label,
    kind: "metric" as const,
  }));
  const biomarkers = getUsedCanonicalNamesWithDerived(profileId).map(
    (name) => ({
      key: bioPinKey(name),
      label: name,
      kind: "biomarker" as const,
    })
  );
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
    const s = buildBiomarkerSeries(profileId, name, range);
    if (s) out.push(s);
  }
  return out;
}
