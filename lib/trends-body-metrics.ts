// The Trends → Body per-metric registry (#1067 Phase 2). ONE source of truth for
// the body metrics that get a sparkline TILE (the overview grid) AND a per-metric
// DETAIL page (`/trends/metric/<slug>`, the biomarker-view pattern applied to body
// metrics). Both surfaces key on this registry so a tile and its detail page can't
// disagree about a metric's label, unit, color, or link (the #285 rule-carrying-link
// + #482 one-identity-per-subject discipline).
//
// This module is PURE (metadata + windowing math, no DB/queries import) so it stays
// unit-testable. The series themselves are gathered by the callers:
//   - the Body tab builds each metric's series ONCE and feeds BOTH the classic chart
//     stack AND the tile grid from it (the tile applies the shared range — one gather,
//     no second computation, #221);
//   - the detail page re-derives its single metric's series through the SAME queries
//     (the biomarker-view precedent — a separate surface re-deriving via the shared
//     query layer), then windows it here.

import { chartSeries } from "./chart-colors";
import { shiftDateStr } from "./date";
import { metricDetailHref, type AppRoute } from "./hrefs";
import { metricSeriesKey, savedRefFromSeriesKey } from "./saved-items";
import { filterSeriesByRange } from "./trends";
import { applyCardOrder, type BodyCardId } from "./trends-card-rank";
import type { DateRange } from "./timeline-format";
import type { BodyMetricKind } from "./types";

// Stable per-metric slugs — the `/trends/metric/<slug>` route param, the tile's
// in-page order key, and the detail-page title source. Append-only (a bookmarked
// detail link must never dangle).
export const BODY_METRIC_SLUGS = [
  // The vitals (#1486) — they joined the Body tab's tile grid when the Vitals tab
  // merged in, so a vital is a tile in `view=tiles` and a full chart in `view=all`,
  // exactly like every body metric. One view-mode semantic, no second grammar.
  "systolic",
  "diastolic",
  "spo2",
  "respiratory-rate",
  "hrv",
  "temperature",
  "skin-temp",
  "weight",
  "body-fat",
  "resting-hr",
  "height",
  "head-circ",
  // Sun / outdoor daylight minutes (#1171) — a derived DAILY series (it aggregates
  // outdoor activity against the solar day at the home location, so it has no
  // per-row store of its own). It became a registered kind in #1488 so the Body
  // tab's sun card taps through like every other chart instead of being the one
  // dead end left on the tab.
  "sun",
  "steps",
  "active-calories",
  "hr",
  "bmi",
  "lean-mass",
  "bone-mass",
  "bmr",
  "hydration",
  "calories",
  "mood",
] as const;
export type BodyMetricSlug = (typeof BODY_METRIC_SLUGS)[number];

// Which quick-add form the detail page offers (null → an integration-synced metric
// with no manual entry, e.g. steps/HR/BMI). Since #1486 there is exactly ONE manual
// form — the combined "Log measurements" — so this is a boolean-shaped union kept as
// a union only because a future second form would land here.
export type BodyQuickAddForm = "measurements" | null;

export interface BodyMetricMeta {
  slug: BodyMetricSlug;
  // Short label for compact chips and menus.
  label: string;
  // Full chart name (tile + classic card + detail-page title and tooltip).
  title: string;
  // Optional concise/shared name for a context that qualifies the title itself.
  // Blood pressure uses it when Today combines systolic/diastolic; heart rate uses
  // it before context suffixes such as "Today" and "Over the Day".
  summaryTitle?: string;
  // Display-unit suffix. Empty for unitless (BMI, steps). Weight's suffix follows
  // the login's weight preference, resolved at runtime (`weightUnit: true`).
  unit: string;
  // When true, the unit suffix is the login's weight unit (appended at runtime).
  weightUnit?: boolean;
  color: string;
  decimals: number;
  // Whether the classic full-chart stack respects the Body tab's shared range.
  // Tiles and metric-detail pages window every metric; synced full charts retain
  // their historical ~6-month behavior.
  windowed: boolean;
  // The Goal.body_metric this metric can carry a target/overlay for, if any.
  goalMetric: BodyMetricKind | null;
  // The detail-page quick-add form, if the metric is manually enterable.
  quickAdd: BodyQuickAddForm;
  // A COUNT metric — steps, calories, hydration — whose chart is floored at zero
  // and whose axis ticks are thousands-grouped. See bodyChartScale() for why the
  // two travel together, and why a ratio/index metric must NOT take them.
  countMetric?: boolean;
}

// The registry. Colors mirror the Body tab's existing chart colors so a metric keeps
// its identity across the tile, the classic chart, and the detail page.
export const BODY_METRIC_META: Record<BodyMetricSlug, BodyMetricMeta> = {
  systolic: {
    slug: "systolic",
    label: "BP Systolic",
    title: "Blood Pressure (Systolic)",
    summaryTitle: "Blood Pressure",
    unit: " mmHg",
    color: chartSeries.rose,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  diastolic: {
    slug: "diastolic",
    label: "BP Diastolic",
    title: "Blood Pressure (Diastolic)",
    summaryTitle: "Blood Pressure",
    unit: " mmHg",
    color: chartSeries.violet,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  spo2: {
    slug: "spo2",
    label: "SpO\u2082",
    title: "Oxygen Saturation",
    unit: "%",
    color: chartSeries.sky,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  "respiratory-rate": {
    slug: "respiratory-rate",
    label: "Resp. Rate",
    title: "Respiratory Rate",
    unit: " /min",
    color: chartSeries.violet,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    // No manual entry field — respiratory rate arrives from a device push or a
    // document import, so its detail page offers no form (like steps/HR/BMI).
    quickAdd: null,
  },
  hrv: {
    slug: "hrv",
    label: "HRV",
    title: "Heart Rate Variability",
    unit: " ms",
    color: chartSeries.amber,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  // A SIGNED nightly deviation from the tracker's own rolling baseline, not an
  // absolute temperature — which is why it carries 1 decimal (the whole readable
  // range is roughly ±2 °C, where 0dp would flatten it to a constant 0) and why it
  // is NOT the `temperature` slug: wrist skin temperature is a distinct measurement
  // site from core body temperature, kept apart by the #482 exclusion discipline.
  // Import-only (the baseline is the device's and never exposed), so no quick-add.
  "skin-temp": {
    slug: "skin-temp",
    label: "Skin Temp",
    title: "Skin Temperature Variation",
    unit: " °C",
    color: chartSeries.violet,
    decimals: 1,
    windowed: true,
    goalMetric: null,
    quickAdd: null,
  },
  temperature: {
    slug: "temperature",
    label: "Body Temp",
    title: "Body Temperature",
    unit: " \u00b0F",
    color: chartSeries.rose,
    decimals: 1,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  weight: {
    slug: "weight",
    label: "Weight",
    title: "Weight",
    unit: "",
    weightUnit: true,
    color: chartSeries.brand,
    decimals: 1,
    windowed: true,
    goalMetric: "weight",
    quickAdd: "measurements",
  },
  "body-fat": {
    slug: "body-fat",
    label: "Body Fat",
    title: "Body Fat",
    unit: "%",
    color: chartSeries.violet,
    decimals: 1,
    windowed: true,
    goalMetric: "body_fat",
    quickAdd: "measurements",
  },
  "resting-hr": {
    slug: "resting-hr",
    label: "RHR",
    title: "Resting Heart Rate",
    unit: " bpm",
    color: chartSeries.amber,
    decimals: 0,
    windowed: true,
    goalMetric: "resting_hr",
    quickAdd: "measurements",
  },
  height: {
    slug: "height",
    label: "Height",
    title: "Height",
    unit: " cm",
    color: chartSeries.violet,
    decimals: 1,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  "head-circ": {
    slug: "head-circ",
    label: "Head Circ.",
    title: "Head Circumference",
    unit: " cm",
    color: chartSeries.sky,
    decimals: 1,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  sun: {
    slug: "sun",
    label: "Sun",
    title: "Sun / Outdoor Time",
    unit: " min",
    color: chartSeries.amber,
    decimals: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: null,
    // Daily minutes outdoors: a COUNT, so "how far from zero" is the whole signal
    // (#1541). Deliberately NOT set on skin-temp, whose series is a SIGNED
    // deviation from the device's baseline — a zero floor would clip half of it.
    countMetric: true,
  },
  steps: {
    slug: "steps",
    label: "Steps",
    title: "Daily Steps",
    unit: "",
    color: chartSeries.sky,
    decimals: 0,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
    countMetric: true,
  },
  "active-calories": {
    slug: "active-calories",
    label: "Active Cals",
    title: "Active Calories",
    unit: " kcal",
    color: chartSeries.rose,
    decimals: 0,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
    countMetric: true,
  },
  hr: {
    slug: "hr",
    label: "Avg HR",
    title: "Heart Rate (Daily Avg)",
    summaryTitle: "Heart Rate",
    unit: " bpm",
    color: chartSeries.rose,
    decimals: 0,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  bmi: {
    slug: "bmi",
    label: "BMI",
    title: "Body Mass Index",
    unit: "",
    color: chartSeries.sky,
    decimals: 1,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  "lean-mass": {
    slug: "lean-mass",
    label: "Lean Mass",
    title: "Lean Body Mass",
    unit: " kg",
    color: chartSeries.sky,
    decimals: 1,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  "bone-mass": {
    slug: "bone-mass",
    label: "Bone Mass",
    title: "Bone Mass",
    unit: " kg",
    color: chartSeries.violet,
    decimals: 2,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  bmr: {
    slug: "bmr",
    label: "BMR",
    title: "Basal Metabolic Rate",
    unit: " kcal",
    color: chartSeries.rose,
    decimals: 0,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  hydration: {
    slug: "hydration",
    label: "Hydration",
    title: "Hydration",
    unit: " L",
    color: chartSeries.sky,
    decimals: 2,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
    countMetric: true,
  },
  calories: {
    slug: "calories",
    label: "Calories",
    title: "Calories (Intake)",
    unit: " kcal",
    color: chartSeries.amber,
    decimals: 0,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
    countMetric: true,
  },
  mood: {
    slug: "mood",
    label: "Mood",
    title: "Mood",
    unit: "",
    color: chartSeries.amber,
    decimals: 1,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
};

export function isBodyMetricSlug(v: string): v is BodyMetricSlug {
  return (BODY_METRIC_SLUGS as readonly string[]).includes(v);
}

// The first saved metric ids predate the detail-page slug registry. Preserve those
// stored keys while every newer metric uses its slug directly.
const LEGACY_SAVED_METRIC_IDS: Partial<Record<BodyMetricSlug, string>> = {
  "body-fat": "bodyfat",
  "resting-hr": "resting_hr",
};

export function savedMetricIdForBodySlug(slug: BodyMetricSlug): string {
  return LEGACY_SAVED_METRIC_IDS[slug] ?? slug;
}

export function bodyMetricSlugForSavedId(id: string): BodyMetricSlug | null {
  const legacy = Object.entries(LEGACY_SAVED_METRIC_IDS).find(
    ([, savedId]) => savedId === id
  )?.[0];
  if (legacy && isBodyMetricSlug(legacy)) return legacy;
  return isBodyMetricSlug(id) ? id : null;
}

// ── The ★ ↔ Body-card correspondence (#1643) ────────────────────────────────
//
// The Body tab's arrangement is driven by the SAVED store (`saved_items`), whose
// vocabulary is the Trends SERIES KEY ("metric:weight", "bio:ApoB"); the tab's own
// vocabulary is `BodyCardId`. ONE mapping answers both directions — the #482
// one-identity rule, which is why it lives beside `savedMetricIdForBodySlug` (the
// legacy-id table it composes) rather than being restated per surface: the Body
// composition read (which cards are pinned) and the star affordance (what key the
// ★ writes) must never disagree about what a card is called.
//
// Only cards that ARE registered body metrics are pinnable. The three non-metric
// cards — the WHO/CDC growth-percentile card, the Sleep summary tile and the
// intraday "HR (day)" card — have no savable series, so they answer `null` and can
// only ever occupy their ranked slot. A saved trend-metric that is not a body
// metric (training volume) likewise maps to no card.

// A Trends series key → the Body card it pins, or null when it names no Body card.
export function bodyCardIdForSeriesKey(seriesKey: string): BodyCardId | null {
  const ref = savedRefFromSeriesKey(seriesKey);
  if (!ref || ref.kind !== "trend-metric") return null;
  return bodyMetricSlugForSavedId(ref.key);
}

// The inverse: the series key a Body card's ★ writes, or null when it is unpinnable.
export function seriesKeyForBodyCard(id: BodyCardId): string | null {
  return isBodyMetricSlug(id)
    ? metricSeriesKey(savedMetricIdForBodySlug(id))
    : null;
}

// Resolve a metric's display-unit suffix, appending the login's weight unit for a
// weight-preference metric (weight); every other metric's suffix is static.
export function resolveBodyMetricUnit(
  meta: BodyMetricMeta,
  weightUnit: string
): string {
  return meta.weightUnit ? ` ${weightUnit}` : meta.unit;
}

// A sparkline tile for the overview grid: the metric's metadata + its selected-range
// series (already in display units, oldest→newest) + presence for the has-data gate.
export interface BodyMetricTile {
  slug: BodyMetricSlug;
  title: string;
  label: string;
  href: AppRoute;
  unit: string;
  color: string;
  decimals: number;
  // The points inside the shared Trends range — the tile's sparkline + latest +
  // delta all read from this (no second computation, #221).
  points: { date: string; value: number }[];
  present: boolean;
  latestDate: string | null;
}

// Build one overview tile from a metric's FULL display-unit series (the same array
// the classic chart renders), windowed by the shared Trends range. Presence and
// ordering still use the full series so a temporarily empty range does not make a
// known metric disappear; the tile instead says there is no data in this range.
export function buildBodyMetricTile(
  meta: BodyMetricMeta,
  fullPoints: readonly { date: string; value: number }[],
  weightUnit: string,
  range: DateRange
): BodyMetricTile {
  const points = filterSeriesByRange([...fullPoints], range);
  return {
    slug: meta.slug,
    title: meta.title,
    label: meta.label,
    href: metricDetailHref(meta.slug),
    unit: resolveBodyMetricUnit(meta, weightUnit),
    color: meta.color,
    decimals: meta.decimals,
    points,
    // Presence is over the FULL series, not the selected window — a metric with
    // history still earns its tile and can explicitly show an empty range.
    present: fullPoints.length > 0,
    latestDate:
      fullPoints.length > 0 ? fullPoints[fullPoints.length - 1].date : null,
  };
}

// A descriptor for any orderable overview tile — a metric tile OR a special tile
// (Sleep, which links to its own /sleep page rather than a metric page).
export interface OrderableTile {
  slug: string;
  // Stable in-page/card id — the ranker's key.
  id: string;
  // Short label for the tile / chip.
  label: string;
  // Has-data gate: false ⇒ the tile doesn't render.
  present: boolean;
  // The metric exists, but the selected range has no points. This is a presentation
  // state, not absence: the tile still renders, after every populated tile.
  empty?: boolean;
}

// Stable partition for card collections: preserve the meaningful relevance/user
// order inside both groups, but keep empty selected-range states after cards that
// can answer the user's question now.
export function stableEmptyLast<T>(
  items: readonly T[],
  isEmpty: (item: T) => boolean
): T[] {
  return [
    ...items.filter((item) => !isEmpty(item)),
    ...items.filter((item) => isEmpty(item)),
  ];
}

// Order the overview tiles by the tab's ranked card order (#1490), then sink
// selected-range empty states without disturbing that order inside either group.
// Absent tiles are filtered here (a chip can't point at a tile that isn't rendered).
//
// This replaced `orderBodyCharts`, whose "most-recently-updated first" sort
// resequenced the grid on every device sync; presence is now a ranker signal (and
// an empty series a ranker FLOOR), so the order changes when what a profile tracks
// changes, not when a watch uploads.
export function orderBodyMetricTiles<T extends OrderableTile>(
  tiles: readonly T[],
  order: readonly BodyCardId[]
): T[] {
  const ranked = applyCardOrder(
    tiles.filter((t) => t.present),
    order,
    (t) => t.id
  );
  return stableEmptyLast(ranked, (tile) => tile.empty === true);
}

// Period statistics for a metric detail page: latest / average / min / max / net
// change over each of the 7/30/90-day trailing windows, computed from the metric's
// FULL series (independent of the page's range control, so the windows always mean
// "last N days from today"). A window with no readings reports nulls.
//
// COINCIDENT WINDOWS COLLAPSE (#1541). With fewer than 7 days of history — every
// new install, every freshly connected integration — all three windows contain the
// SAME readings, so every derived figure is identical BY CONSTRUCTION and the card
// rendered the same four numbers three times. Adjacent windows whose membership
// coincides are therefore merged into ONE stat spanning them ("7–90d"), and every
// stat carries the reading `count` and the `from`/`to` dates it actually covers, so
// a trio that legitimately differs is explicable rather than merely repetitive.
export interface PeriodStat {
  // The window label: "7d" for a single window, "7–90d" for a collapsed run.
  label: string;
  // The WIDEST trailing window this stat represents — its stable key/testid.
  days: number;
  // Every trailing window whose readings this stat covers: [7] or [7, 30, 90].
  windows: number[];
  count: number;
  // First / last reading DATE inside the window (null when it holds none) — what
  // the card is actually summarising, as opposed to what it is labelled.
  from: string | null;
  to: string | null;
  latest: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  delta: number | null;
}

// The trailing windows, ascending. Nested by construction (7d ⊂ 30d ⊂ 90d) — the
// property the collapse predicate below leans on.
const PERIOD_WINDOWS = [7, 30, 90] as const;

function periodLabel(windows: readonly number[]): string {
  return windows.length === 1
    ? `${windows[0]}d`
    : `${windows[0]}–${windows[windows.length - 1]}d`;
}

// Merge adjacent windows that cover the SAME readings into one stat.
//
// The membership test is the reading COUNT, not the points themselves: the windows
// are nested, so a wider window holding the same number of readings as the one
// inside it necessarily holds exactly those readings. Exported for the pure test —
// this predicate is the whole of #1541's first fix.
export function collapseCoincidentPeriods(
  stats: readonly PeriodStat[]
): PeriodStat[] {
  const out: PeriodStat[] = [];
  for (const s of stats) {
    const prev = out[out.length - 1];
    if (prev && prev.count === s.count) {
      const windows = [...prev.windows, ...s.windows];
      out[out.length - 1] = {
        ...prev,
        days: s.days,
        windows,
        label: periodLabel(windows),
      };
      continue;
    }
    out.push(s);
  }
  return out;
}

export function bodyMetricPeriodStats(
  points: readonly { date: string; value: number }[],
  todayStr: string,
  decimals = 1
): PeriodStat[] {
  const round = (n: number) => Number(n.toFixed(decimals));
  const raw = PERIOD_WINDOWS.map((days): PeriodStat => {
    const cutoff = shiftDateStr(todayStr, -(days - 1));
    const win = points.filter((p) => p.date >= cutoff);
    const vals = win.map((p) => p.value);
    if (vals.length === 0) {
      return {
        label: `${days}d`,
        days,
        windows: [days],
        count: 0,
        from: null,
        to: null,
        latest: null,
        avg: null,
        min: null,
        max: null,
        delta: null,
      };
    }
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      label: `${days}d`,
      days,
      windows: [days],
      count: vals.length,
      from: win[0].date,
      to: win[win.length - 1].date,
      latest: round(vals[vals.length - 1]),
      avg: round(sum / vals.length),
      min: round(Math.min(...vals)),
      max: round(Math.max(...vals)),
      delta: round(vals[vals.length - 1] - vals[0]),
    };
  });
  return collapseCoincidentPeriods(raw);
}

// The chart's honesty caption (#1541 fix 4). The metric detail page defaults to the
// 90D window (#1507, inherited so a drill-in from a tile doesn't rewind the range),
// so with a week of history the pill says 90D while the axis says 07-19 → 07-25 and
// nothing reconciles the two — the reader can't tell whether data is missing, the
// sync is broken, or the control is.
//
// Returned ONLY when the selected range extends past the first reading, i.e. when
// the window is NOT what bounds the plot: then the caption names what is actually
// drawn. A range that genuinely clips the series gets no caption — the pill already
// describes it truthfully.
//
// Dates are rendered MM-DD, the same form the chart's own x-axis tick uses, so the
// caption reads as a label FOR the axis rather than a second date vocabulary.
export function seriesCoverageNote(
  windowed: readonly { date: string }[],
  range: { from?: string | null; to?: string | null }
): string | null {
  if (windowed.length === 0) return null;
  const first = windowed[0].date;
  const last = windowed[windowed.length - 1].date;
  const openStart = !range.from || range.from < first;
  if (!openStart) return null;
  const openEnd = !range.to || range.to >= last;
  const n = windowed.length;
  const md = (d: string) => d.slice(5);
  return `${openEnd ? "All " : ""}${n} reading${n === 1 ? "" : "s"}, ${md(first)} → ${md(last)}`;
}

// The axis treatment a COUNT metric's chart takes (#1541 fixes 5 + "Also").
//
// Two consequences of one predicate, which is why they share a flag rather than
// two. A count's distance from ZERO is its signal: recharts' ["auto","auto"] floors
// the steps axis at 6000, so 6931 vs 11214 — a 1.6× spread — renders as a
// near-zero-to-peak swing and ordinary day-to-day variance looks dramatic. And a
// count runs to four and five digits, where an ungrouped `12000` tick is simply
// harder to read than `12,000`. Ratio/index metrics (weight, BMI, resting HR) keep
// the auto domain, where a zero baseline would flatten the signal instead.
export function bodyChartScale(meta: BodyMetricMeta): {
  yDomain?: [number | "auto", number | "auto"];
  groupYTicks?: boolean;
} {
  return meta.countMetric
    ? { yDomain: [0, "auto"], groupYTicks: true }
    : { yDomain: undefined, groupYTicks: undefined };
}
