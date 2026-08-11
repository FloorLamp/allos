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
  getUsedCanonicalNamesWithDerived,
  getMedicationCourses,
  getSupplements,
  getAppointments,
  getProtocolWindows,
  getPracticeTrends,
  getRankedBiomarkerOptions,
} from "./queries";
import { today } from "./db";
import type { BiomarkerPickerGroup } from "./biomarker-rank";
import { bodyMetricKindForBiomarker } from "./outcome-identity";
import { getUnitPrefs, getProfileAge, getSituationEvents } from "./settings";
import { showBodyFat } from "./growth-metrics";
import {
  buildAnnotations,
  buildProtocolWindows,
  type TrendAnnotation,
  type TrendWindow,
} from "./trend-annotations";
import { dispWeight, round } from "./units";
import {
  ALL_ROWS,
  filterSeriesByRange,
  outOfWindowAgeLabel,
  outOfWindowLatest,
} from "./trends";
import {
  BODY_METRIC_META,
  bodyMetricSlugForSavedId,
  resolveBodyMetricUnit,
  savedMetricIdForBodySlug,
} from "./trends-body-metrics";
import { fullBodyMetricSeries } from "./body-metric-series";
// The analyte-plot leaf both this module and the biomarker-goal reader depend on
// (#1853): one answer to "what does this analyte's series look like, in what unit".
import { biomarkerPlot } from "./queries/biomarker-plot";
import { activeRangeLabel } from "./trends-context";
import { bioSeriesKey, metricSeriesKey } from "./saved-items";
import { bioColor } from "./trend-colors";
import type { DigestSeries } from "./trends-digest";
import {
  practiceDigestEligible,
  practiceDigestKey,
  practiceTrendWindow,
  PRACTICE_DIGEST_MIN_CHANGE,
} from "./trends-practices";
import type { DateRange } from "./timeline-format";
import { readingDetailHref, metricDetailHref, type AppRoute } from "./hrefs";

export interface TrendSeries {
  key: string; // "metric:weight" | "bio:LDL Cholesterol" — also the pin key
  label: string;
  // Registry-owned compact label for phone tiles. Full `label` remains the chart
  // and detail title; biomarkers omit this because their canonical name is the
  // only honest label.
  shortLabel?: string;
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
    rangeLabel: string;
  } | null;
}

export interface TrendOption {
  key: string;
  label: string;
  kind: "metric" | "biomarker";
  // Which relevance bucket a biomarker option belongs to (#1675). Metrics carry
  // none — they are their own picker group.
  group?: BiomarkerPickerGroup;
}

// Deterministic biomarker colors live in the pure lib/trend-colors module (no DB
// imports) so the Compare color logic stays unit-testable; re-exported here so
// existing import sites keep working (bioColor is also imported above for local
// use, since a re-export alone doesn't bind it in module scope).
export { deCollideColor, BIO_COLORS } from "./trend-colors";

interface MetricDef {
  id: string; // "weight" — the metricPinKey suffix
  label: string;
  shortLabel?: string;
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
    label: BODY_METRIC_META.weight.title,
    shortLabel: BODY_METRIC_META.weight.label,
    unit: "",
    color: BODY_METRIC_META.weight.color,
    href: metricDetailHref("weight"),
    decimals: BODY_METRIC_META.weight.decimals,
    minPctChange: 0.02, // a 2% weight change is already meaningful
  },
  {
    id: "bodyfat",
    label: BODY_METRIC_META["body-fat"].title,
    shortLabel: BODY_METRIC_META["body-fat"].label,
    unit: BODY_METRIC_META["body-fat"].unit,
    color: BODY_METRIC_META["body-fat"].color,
    href: metricDetailHref("body-fat"),
    decimals: BODY_METRIC_META["body-fat"].decimals,
    // default 0.05
  },
  {
    id: "resting_hr",
    label: BODY_METRIC_META["resting-hr"].title,
    shortLabel: BODY_METRIC_META["resting-hr"].label,
    unit: BODY_METRIC_META["resting-hr"].unit,
    color: BODY_METRIC_META["resting-hr"].color,
    href: metricDetailHref("resting-hr"),
    decimals: BODY_METRIC_META["resting-hr"].decimals,
    minPctChange: 0.05, // resting HR is fairly stable; 5% is a genuine shift
  },
  {
    id: "volume",
    label: "Training Volume",
    shortLabel: "Training Volume",
    unit: "",
    color: "#0ea5e9",
    href: "/training?tab=analyze",
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
  const hideBodyFat = !showBodyFat(getProfileAge(profileId));

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
    shortLabel: d.shortLabel,
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

// Rebuild a saved Body metric that is not one of the original standard Overview
// series. Metric-detail pages can star every registered Body slug; this is the
// corresponding read path that makes that saved row a real Overview tile.
export function buildSavedBodyMetricSeries(
  profileId: number,
  loginId: number,
  savedId: string,
  range: DateRange,
  todayStr: string
): TrendSeries | null {
  const slug = bodyMetricSlugForSavedId(savedId);
  if (!slug) return null;
  const meta = BODY_METRIC_META[slug];
  const weightUnit = getUnitPrefs(loginId).weightUnit;
  return {
    key: metricSeriesKey(savedMetricIdForBodySlug(slug)),
    label: meta.title,
    shortLabel: meta.label,
    unit: resolveBodyMetricUnit(meta, weightUnit),
    color: meta.color,
    href: metricDetailHref(slug),
    kind: "metric",
    decimals: meta.decimals,
    points: filterSeriesByRange(
      fullBodyMetricSeries(slug, profileId, weightUnit, todayStr),
      range
    ),
    range: null,
  };
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
    href: readingDetailHref(canonical),
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
    href: readingDetailHref(canonical),
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
      rangeLabel: activeRangeLabel(range, todayStr),
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
    href: readingDetailHref(canonical),
    kind: "biomarker",
    decimals: 1,
    points: [],
    range: null,
  };
}

// The pickable Compare options: the standard metrics plus every biomarker that has
// stored readings (canonical names in use). Series are built lazily by
// resolveSeriesByKey so listing stays cheap.
//
// The biomarker half comes back RELEVANCE-ORDERED and group-tagged (#1675) — the same
// `getRankedBiomarkerOptions` the record form and the import mapping field read, so a
// retest-due or flagged analyte leads every picker rather than whatever starts with
// "A". MEMBERSHIP is untouched: the age gates above and the body-metric exclusion below
// still decide what is offered at all, so a gated metric is neither tile nor option.
export function listCompareOptions(
  profileId: number,
  restricted: boolean
): { metrics: TrendOption[]; biomarkers: TrendOption[] } {
  const hideBodyFat = !showBodyFat(getProfileAge(profileId));
  const metrics = METRIC_DEFS.filter(
    (d) => !(d.restricted && restricted) && !(d.id === "bodyfat" && hideBodyFat)
  ).map((d) => ({
    key: metricSeriesKey(d.id),
    label: d.label,
    kind: "metric" as const,
  }));
  const names = getUsedCanonicalNamesWithDerived(profileId).filter(
    (name) => bodyMetricKindForBiomarker(name) == null
  );
  const biomarkers = getRankedBiomarkerOptions(
    profileId,
    today(profileId),
    names
  ).map((option) => ({
    key: bioSeriesKey(option.name),
    label: option.name,
    kind: "biomarker" as const,
    group: option.group,
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
      date: a.date,
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

// A wellness practice's CADENCE as a digest candidate (#1632).
//
// The digest is a %-move engine over a windowed numeric series, and "days logged
// per completed week" is exactly that shape — so a practice whose cadence really
// moved can say so beside the metrics that moved. What the digest's pattern does
// NOT support is a streak or a range verdict: it has no notion of a floor, and the
// one thing it does with a `range` is paint a crossing amber/rose, which is the
// attention badge a coaching-tier practice signal must never grow. So these series
// deliberately carry NO range — the chip stays neutral — and the consistency and
// streak half of #1632 lives in the Trends wellness lens, which can state it
// properly.
//
// Strict by construction: TRACKED practices only (an untracked practice's session
// count moving is not a commitment moving), at least PRACTICE_DIGEST_MIN_WEEKS of
// completed history, and a third-of-a-cadence bar instead of the global 5% — one
// extra sauna in a 3×/week habit is already a 33% move, so the default threshold
// is meaningless on small integers.
export function buildPracticeDigestSeries(
  profileId: number,
  range: DateRange,
  todayStr: string
): DigestSeries[] {
  const window = practiceTrendWindow(range, todayStr);
  return getPracticeTrends(profileId, window.weeks, window.asOf)
    .filter((practice) => practiceDigestEligible(practice))
    .map((practice) => ({
      key: practiceDigestKey(practice.identity),
      label: `${practice.name} cadence`,
      unit: "/wk",
      points: practice.weeks.map((week) => ({
        date: week.start,
        value: week.count,
      })),
      minPctChange: PRACTICE_DIGEST_MIN_CHANGE,
    }));
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
