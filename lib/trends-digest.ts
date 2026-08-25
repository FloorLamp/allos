// "What's trending" digest for the Trends hub. Given a set
// of windowed, date-keyed numeric series (body/training metrics and biomarkers),
// admit only moves that are NEWS inside the selected window: a reference/notability
// crossing, a level shift large against the series' own dispersion, or a change in
// the behavior of the leading and trailing halves. Ranks by significance and
// returns the top few with human labels.
// Pure and exhaustively unit-tested; range logic reuses referenceStatus from
// lib/reference-range so it agrees with the biomarker machinery. Flat /
// insufficient-data series are excluded, never errored.
//
// Robustness (#37): the magnitude is measured between ROBUST endpoints — the
// median of the first k and last k readings (k = min(3, floor(n/2))) — not the
// literal first and last points, so a single noisy endpoint no longer defines the
// whole trend. For 2–3 point series k collapses to 1, i.e. the exact old
// first-vs-last behavior.

import {
  daysBetween,
  flagLabel,
  flagTone,
  isNotableFlag,
  referenceStatus,
  type FlagTone,
} from "./reference-range";
import { clinicalResultBecameNotable } from "./dashboard-reading-promotions";
import {
  median,
  medianAbsoluteDeviation,
  robustEndpoints,
  theilSenSlopePerDay,
} from "./robust-stats";
import { round } from "./units";

// After removing the steady slope already present inside both halves, a level
// shift must exceed four times the noisier half's MAD. The strict comparison
// admits a step between otherwise stable levels while rejecting ordinary residual
// variation; detrending is what makes that answer independent of sample count.
export const DIGEST_DISPERSION_MULTIPLIER = 4;

// A same-direction behavior change must at least double the fitted slope, and the
// difference projected across a half-window must clear two MADs. The ratio catches
// an actual pace change; the dispersion floor keeps small fitted jitter from doing
// so. A sign flip is independently news once the shared endpoint move is material.
export const DIGEST_SLOPE_RATIO = 2;
export const DIGEST_SLOPE_DISPERSION_MULTIPLIER = 2;

export interface DigestSeries {
  key: string;
  label: string;
  // Display-unit suffix for the absolute-change phrasing (e.g. " bpm", " kg").
  unit?: string;
  // Chronological (oldest → newest) numeric points, already windowed to the range
  // and in a single unit. Nulls should be filtered out by the caller.
  points: { date: string; value: number }[];
  // Optional plain [low, high] reference range in the SAME unit as `points`, so a
  // move can be classified as crossing into/out of range. Omit for metrics without
  // a clinical range (weight, volume, …).
  range?: { low: number | null; high: number | null } | null;
  // Stored verdicts on the oldest/newest plottable readings in this window. When
  // present, crossing classification uses the shared NOTABLE tier instead of
  // re-judging the values against plain bounds. Metrics omit this field.
  endpointFlags?: {
    first: string | null;
    last: string | null;
  };
  // Optional per-series materiality threshold (fraction), overriding the global
  // DigestOptions.minPctChange for THIS series. Lets a caller pick a metric-aware
  // bar — 2% is a real weight move but noise for step counts — instead of one
  // threshold for everything. Falls back to the global option, then 0.05.
  minPctChange?: number;
}

export type RangeShift = "into-range" | "out-of-range" | "through-range" | null;
export type TrendAdmissionReason =
  "range-crossing" | "dispersion-shift" | "behavior-change";

export interface TrendItem {
  key: string;
  label: string;
  // A stored clinical verdict can change while the recorded numeric value stays
  // equal. That is still news, but it has no honest numeric arrow.
  direction: "up" | "down" | "flat";
  // Robust endpoint VALUES (#37): the median of the first k / last k readings, not
  // the literal first/last points. For 2–3 point series these are the raw
  // first/last values.
  first: number;
  last: number;
  absChange: number;
  // (last − first) / |first|, or null when first is 0 (percentage undefined).
  pctChange: number | null;
  // Whole days spanned by the first and last reading.
  days: number;
  count: number;
  rangeShift: RangeShift;
  admissionReason: TrendAdmissionReason;
  // The source-of-truth tone of the latest STORED clinical flag. This stays
  // separate from `rangeShift`: the latter ranks a newly notable result, while
  // this distinguishes an app out-of-range verdict (`bad`) from an optimal-band
  // or lab-reported verdict (`warn`) at the display boundary.
  storedFlagTone?: FlagTone;
  // Where the LATEST value sits vs the range ("above" / "below" / "in"), when a
  // range was supplied — drives the "into high/low range" phrasing.
  lastStatus: "above" | "below" | "in" | "unknown";
  // Relative magnitude within a crossing tier; not shown, used only to sort.
  magnitude: number;
  text: string;
}

export interface DigestOptions {
  // Max items returned (default 5).
  limit?: number;
  // A move must change by at least this fraction to clear the shared materiality
  // base (default 0.05 = 5%) — UNLESS it crossed a reference range, which always
  // qualifies. The digest then applies its additional news gate. A per-series
  // DigestSeries.minPctChange overrides this for that series.
  minPctChange?: number;
}

// Relative magnitude within a ranking tier. A first-value of 0 (pctChange null
// but non-zero move) is treated as a large relative move so it isn't sorted to
// the bottom.
function magnitudeOf(pctChange: number | null): number {
  return pctChange == null ? 1 : Math.abs(pctChange);
}

// Crossings are categorical ranking tiers rather than finite score boosts, so no
// size of ordinary move can outrank one. Preserve the existing precedence among
// crossing kinds, then compare relative magnitude within the same tier.
function crossingRank(shift: RangeShift): number {
  return shift === "out-of-range"
    ? 3
    : shift === "through-range"
      ? 2
      : shift === "into-range"
        ? 1
        : 0;
}

function classifyShift(
  first: number,
  last: number,
  range: { low: number | null; high: number | null } | null | undefined
): { shift: RangeShift; lastStatus: TrendItem["lastStatus"] } {
  if (!range || (range.low == null && range.high == null)) {
    return { shift: null, lastStatus: "unknown" };
  }
  const firstStatus = referenceStatus(first, range.low, range.high);
  const lastStatus = referenceStatus(last, range.low, range.high);
  const firstOut = firstStatus === "above" || firstStatus === "below";
  const lastOut = lastStatus === "above" || lastStatus === "below";
  let shift: RangeShift = null;
  if (!firstOut && lastOut) shift = "out-of-range";
  else if (firstOut && lastStatus === "in") shift = "into-range";
  // Both ends out of range on OPPOSITE sides (below→above or above→below): the
  // value swung the whole way through the reference range. Same-side-both-out
  // stays null (annotated by magnitude only).
  else if (firstOut && lastOut && firstStatus !== lastStatus)
    shift = "through-range";
  return { shift, lastStatus };
}

interface DigestShift {
  shift: RangeShift;
  lastStatus: TrendItem["lastStatus"];
  storedFlag: string | null | undefined;
  storedFlagTone: FlagTone | undefined;
}

// Stored clinical flags are already the shared domain verdict used by dashboard
// promotion. When they exist, the digest relays their NOTABLE-tier transition and
// never substitutes a fresh plain-bound judgment. With no stored verdict (ordinary
// metrics and range-only series), the existing numeric classification remains.
function classifyDigestShift(
  first: number,
  last: number,
  series: Pick<DigestSeries, "range" | "endpointFlags">
): DigestShift {
  if (
    !series.endpointFlags ||
    (series.endpointFlags.first == null && series.endpointFlags.last == null)
  ) {
    return {
      ...classifyShift(first, last, series.range),
      storedFlag: undefined,
      storedFlagTone: undefined,
    };
  }

  const firstNotable = isNotableFlag(series.endpointFlags.first);
  const lastNotable = isNotableFlag(series.endpointFlags.last);
  const flag = series.endpointFlags.last;
  const lastStatus: TrendItem["lastStatus"] =
    flag === "high" || flag === "non-optimal-high" || flag === "reported-high"
      ? "above"
      : flag === "low" || flag === "non-optimal-low" || flag === "reported-low"
        ? "below"
        : lastNotable
          ? "unknown"
          : "in";
  return {
    shift: clinicalResultBecameNotable(flag, series.endpointFlags.first)
      ? "out-of-range"
      : firstNotable && !lastNotable
        ? "into-range"
        : null,
    lastStatus,
    storedFlag: flag,
    storedFlagTone: flagTone(flag),
  };
}

type BehaviorChange = "direction-flip" | "pace-change";

interface NewsVerdict {
  reason: TrendAdmissionReason;
  behaviorChange?: BehaviorChange;
}

function halves(points: readonly { date: string; value: number }[]): {
  leading: { date: string; value: number }[];
  trailing: { date: string; value: number }[];
} {
  const split = Math.floor(points.length / 2);
  return {
    leading: points.slice(0, split),
    trailing: points.slice(split),
  };
}

function halfDispersion(
  leading: readonly { value: number }[],
  trailing: readonly { value: number }[]
): number {
  return Math.max(
    medianAbsoluteDeviation(leading.map(({ value }) => value)),
    medianAbsoluteDeviation(trailing.map(({ value }) => value))
  );
}

function dispersionShift(
  leading: readonly { date: string; value: number }[],
  trailing: readonly { date: string; value: number }[]
): boolean {
  // Each half needs enough observations to establish its own dispersion and
  // slope. One point per half can prove a crossing, but not a level shift against
  // the series' own variation.
  if (leading.length < 2 || trailing.length < 2) return false;
  const observedChange =
    median(trailing.map(({ value }) => value)) -
    median(leading.map(({ value }) => value));

  // Remove the slope already present INSIDE both halves before asking whether
  // their levels differ. A raw half-median gap grows with sample count even for
  // a perfectly steady ramp (8 points happened to equal the 4×MAD floor; 10
  // points exceeded it). The median of the two within-half Theil–Sen slopes is
  // deliberately used instead of a fit over the whole window: cross-half pairs
  // contain the very step this gate is meant to detect and would fit it away.
  const leadingSlope = theilSenSlopePerDay(leading);
  const trailingSlope = theilSenSlopePerDay(trailing);
  let expectedChange = 0;
  if (leadingSlope != null && trailingSlope != null) {
    const origin = leading[0].date;
    const leadingCenter = median(
      leading.map(({ date }) => daysBetween(origin, date))
    );
    const trailingCenter = median(
      trailing.map(({ date }) => daysBetween(origin, date))
    );
    expectedChange =
      median([leadingSlope, trailingSlope]) * (trailingCenter - leadingCenter);
  }
  const detrendedChange = Math.abs(observedChange - expectedChange);
  return (
    detrendedChange >
    DIGEST_DISPERSION_MULTIPLIER * halfDispersion(leading, trailing)
  );
}

function behaviorChange(
  leading: readonly { date: string; value: number }[],
  trailing: readonly { date: string; value: number }[]
): BehaviorChange | null {
  if (leading.length < 2 || trailing.length < 2) return null;
  const firstSlope = theilSenSlopePerDay(leading);
  const lastSlope = theilSenSlopePerDay(trailing);
  if (firstSlope == null || lastSlope == null) return null;
  if (firstSlope * lastSlope < 0) return "direction-flip";

  const slow = Math.min(Math.abs(firstSlope), Math.abs(lastSlope));
  const fast = Math.max(Math.abs(firstSlope), Math.abs(lastSlope));
  const ratioChanged =
    slow === 0 ? fast > 0 : fast / slow >= DIGEST_SLOPE_RATIO;
  if (!ratioChanged) return null;

  const leadingDays = daysBetween(
    leading[0].date,
    leading[leading.length - 1].date
  );
  const trailingDays = daysBetween(
    trailing[0].date,
    trailing[trailing.length - 1].date
  );
  const projectedDifference =
    Math.abs(lastSlope - firstSlope) * Math.min(leadingDays, trailingDays);
  return projectedDifference >=
    DIGEST_SLOPE_DISPERSION_MULTIPLIER * halfDispersion(leading, trailing)
    ? "pace-change"
    : null;
}

function newsVerdict(
  points: readonly { date: string; value: number }[],
  shift: RangeShift
): NewsVerdict | null {
  if (shift != null) return { reason: "range-crossing" };
  const { leading, trailing } = halves(points);
  const changed = behaviorChange(leading, trailing);
  if (changed) {
    return { reason: "behavior-change", behaviorChange: changed };
  }
  return dispersionShift(leading, trailing)
    ? { reason: "dispersion-shift" }
    : null;
}

function buildText(
  item: Omit<TrendItem, "text">,
  unitSuffix: string,
  verdict: NewsVerdict,
  storedFlag: string | null | undefined
): string {
  const arrow =
    item.direction === "up" ? "↑" : item.direction === "down" ? "↓" : null;
  const mag =
    item.pctChange != null
      ? `${Math.round(Math.abs(item.pctChange) * 100)}%`
      : `${round(Math.abs(item.absChange), 1)}${unitSuffix}`;
  const base = arrow ? `${item.label} ${arrow} ${mag}` : item.label;
  if (item.rangeShift === "out-of-range") {
    if (storedFlag !== undefined) {
      return `${base} — ${flagLabel(storedFlag).toLowerCase()}`;
    }
    const where = item.lastStatus === "above" ? "high" : "low";
    return `${base} — into ${where} range`;
  }
  if (item.rangeShift === "into-range") {
    if (storedFlag !== undefined) {
      return storedFlag === "immune"
        ? `${base} — now marked immune`
        : `${base} — back to normal`;
    }
    return `${base} — back into range`;
  }
  if (item.rangeShift === "through-range") {
    // Ended above → swung low→high; ended below → swung high→low.
    const dir = item.lastStatus === "above" ? "low→high" : "high→low";
    return `${base} — crossed the range ${dir}`;
  }
  if (verdict.reason === "behavior-change") {
    return verdict.behaviorChange === "direction-flip"
      ? `${item.label} changed direction within this range`
      : `${item.label}'s rate of change shifted within this range`;
  }
  return `${base} — larger than its recent variation`;
}

// The robust-endpoint summary of ONE series — the shared core of the digest AND
// the Overview TrendMiniCard badge (#398), so the tile arrow and the digest chip
// can never render two different verdicts about the same series on the same screen.
// Measures the move between ROBUST endpoints (median of the first/last k readings,
// k = min(3, ⌊n/2⌋); #37) rather than the literal first/last points, and reports
// whether that move clears the shared MATERIALITY base: the per-series (or global)
// minPctChange bar OR a reference-range crossing. summarizeTrends applies the news
// gate above this result; the tile keeps using this result unchanged. Returns null
// for a series with fewer than 2 finite points.
export interface RobustSummary {
  count: number;
  // Robust endpoint values (median of first/last k), not the literal first/last.
  first: number;
  last: number;
  // last − first (robust), so positive = the metric rose over the window.
  absChange: number;
  // (last − first) / |first|, or null when first is 0.
  pctChange: number | null;
  direction: "up" | "down" | "flat";
  // True when the move clears the shared tile/digest base: it clears minPctChange,
  // or crossed a reference range. A material move always has a non-flat direction.
  material: boolean;
}

// `points` must be CHRONOLOGICAL (oldest → newest) — the order every body-metric /
// volume / biomarker series is shaped into before charting, and what makes "first k"
// and "last k" mean the start and end of the window. Nulls and non-finite values are
// filtered here, so a caller may pass a series with gaps (the `DigestSeries.points`
// contract is stricter: already null-free).
export function robustSeriesSummary(
  series: Pick<DigestSeries, "range" | "minPctChange"> & {
    points: readonly { value: number | null }[];
  },
  globalMinPct = 0.05
): RobustSummary | null {
  const pts = series.points.filter(
    (p): p is { value: number } => p.value != null && Number.isFinite(p.value)
  );
  if (pts.length < 2) return null;
  const k = Math.min(3, Math.floor(pts.length / 2));
  const { first, last } = robustEndpoints(pts, k);
  const absChange = last - first;
  const pctChange = first !== 0 ? absChange / Math.abs(first) : null;
  const direction: RobustSummary["direction"] =
    absChange > 0 ? "up" : absChange < 0 ? "down" : "flat";
  const { shift } = classifyShift(first, last, series.range);
  const minPct = series.minPctChange ?? globalMinPct;
  const relMag = pctChange == null ? 1 : Math.abs(pctChange);
  const material = absChange !== 0 && (relMag >= minPct || shift != null);
  return {
    count: pts.length,
    first,
    last,
    absChange,
    pctChange,
    direction,
    material,
  };
}

// Compute the ranked, human-labeled news list. The unchanged shared endpoint
// summary first establishes direction/materiality; this additional gate admits
// only crossings, dispersion-significant level shifts, and in-window behavior
// changes. Crossings rank categorically first; ties break on relative magnitude,
// then label.
export function summarizeTrends(
  series: readonly DigestSeries[],
  opts: DigestOptions = {}
): TrendItem[] {
  const limit = opts.limit ?? 5;
  const globalMinPct = opts.minPctChange ?? 0.05;

  const items: TrendItem[] = [];
  for (const s of series) {
    const pts = s.points.filter((p) => Number.isFinite(p.value));
    if (pts.length < 2) continue; // insufficient data
    // Shared robust-endpoint core (#398): the SAME summary the Overview tile badge
    // renders, so the chip and the tile agree on first/last/delta and materiality.
    const summary = robustSeriesSummary(s, globalMinPct);
    if (!summary) continue;
    const { first, last, absChange, pctChange } = summary;
    const { shift, lastStatus, storedFlag, storedFlagTone } =
      classifyDigestShift(first, last, s);
    // A flat numeric summary stays flat for the shared TrendMiniCard. The digest
    // only makes an exception when the stored clinical verdict itself crossed.
    if (summary.direction === "flat" && shift == null) continue;
    // A stored notability transition is itself the shared clinical materiality
    // verdict. Otherwise preserve robustSeriesSummary's existing threshold gate.
    if (!summary.material && shift == null) continue;
    const verdict = newsVerdict(pts, shift);
    if (!verdict) continue;

    const direction = summary.direction;
    const days = daysBetween(pts[0].date, pts[pts.length - 1].date);
    const magnitude = magnitudeOf(pctChange);
    const core: Omit<TrendItem, "text"> = {
      key: s.key,
      label: s.label,
      direction,
      first,
      last,
      absChange,
      pctChange,
      days,
      count: pts.length,
      rangeShift: shift,
      admissionReason: verdict.reason,
      storedFlagTone,
      lastStatus,
      magnitude,
    };
    items.push({
      ...core,
      text: buildText(core, s.unit ?? "", verdict, storedFlag),
    });
  }

  items.sort(
    (x, y) =>
      crossingRank(y.rangeShift) - crossingRank(x.rangeShift) ||
      y.magnitude - x.magnitude ||
      x.label.localeCompare(y.label)
  );
  return items.slice(0, Math.max(0, limit));
}
