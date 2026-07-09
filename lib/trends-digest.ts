// "What's trending" digest for the Trends hub (issue #212, Phase 2). Given a set
// of windowed, date-keyed numeric series (body/training metrics and biomarkers),
// auto-detect which ones are actually MOVING over the selected window — direction
// + magnitude (first-vs-last) — and, for biomarkers carrying a canonical
// reference range, whether the move crossed INTO or OUT OF range. Ranks by
// significance and returns the top few with human labels ("Resting HR ↓ 6% over
// 90d", "LDL ↑ into high range"). Pure and exhaustively unit-tested; range logic
// reuses referenceStatus from lib/reference-range so it agrees with the biomarker
// machinery. Flat / insufficient-data series are excluded, never errored.

import { daysBetween, referenceStatus } from "./reference-range";
import { round } from "./units";

export interface DigestSeries {
  key: string;
  label: string;
  // Display-unit suffix for the absolute-change phrasing (e.g. " bpm", " kg").
  unit?: string;
  // Chronological (oldest → newest) numeric points, already windowed to the range
  // and in a single unit. Nulls should be filtered out by the caller.
  points: { date: string; value: number }[];
  // Optional plain [low, high] reference range in the SAME unit as `points`, so a
  // first-vs-last move can be classified as crossing into/out of range. Omit for
  // metrics without a clinical range (weight, volume, …).
  range?: { low: number | null; high: number | null } | null;
}

export type RangeShift = "into-range" | "out-of-range" | "through-range" | null;

export interface TrendItem {
  key: string;
  label: string;
  direction: "up" | "down";
  first: number;
  last: number;
  absChange: number;
  // (last − first) / |first|, or null when first is 0 (percentage undefined).
  pctChange: number | null;
  // Whole days spanned by the first and last reading.
  days: number;
  count: number;
  rangeShift: RangeShift;
  // Where the LATEST value sits vs the range ("above" / "below" / "in"), when a
  // range was supplied — drives the "into high/low range" phrasing.
  lastStatus: "above" | "below" | "in" | "unknown";
  // Ranking score (higher = more significant); not shown, used only to sort.
  magnitude: number;
  text: string;
}

export interface DigestOptions {
  // Max items returned (default 5).
  limit?: number;
  // A move must change by at least this fraction to count as "trending" (default
  // 0.05 = 5%) — UNLESS it crossed a reference range, which always qualifies.
  minPctChange?: number;
}

// Rank score: a range crossing dominates (an out-of-range move above an
// into-range move), then the relative magnitude of the change. A first-value of 0
// (pctChange null but non-zero move) is treated as a large relative move so it
// isn't sorted to the bottom.
function scoreOf(pctChange: number | null, shift: RangeShift): number {
  const rel = pctChange == null ? 1 : Math.abs(pctChange);
  const shiftBoost =
    shift === "out-of-range"
      ? 1000
      : shift === "through-range"
        ? 750
        : shift === "into-range"
          ? 500
          : 0;
  return shiftBoost + rel;
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

function buildText(item: Omit<TrendItem, "text">, unitSuffix: string): string {
  const arrow = item.direction === "up" ? "↑" : "↓";
  const mag =
    item.pctChange != null
      ? `${Math.round(Math.abs(item.pctChange) * 100)}%`
      : `${round(Math.abs(item.absChange), 1)}${unitSuffix}`;
  const base = `${item.label} ${arrow} ${mag} over ${item.days}d`;
  if (item.rangeShift === "out-of-range") {
    const where = item.lastStatus === "above" ? "high" : "low";
    return `${base} — into ${where} range`;
  }
  if (item.rangeShift === "into-range") {
    return `${base} — back into range`;
  }
  if (item.rangeShift === "through-range") {
    // Ended above → swung low→high; ended below → swung high→low.
    const dir = item.lastStatus === "above" ? "low→high" : "high→low";
    return `${base} — crossed the range ${dir}`;
  }
  return base;
}

// Compute the ranked, human-labeled "what's trending" list. Series with fewer
// than 2 points, or a net change of 0 (flat), are excluded. A move is kept when it
// changed by at least `minPctChange` OR crossed a reference range. Ties break on
// the ranking score, then the label for a stable order.
export function summarizeTrends(
  series: readonly DigestSeries[],
  opts: DigestOptions = {}
): TrendItem[] {
  const limit = opts.limit ?? 5;
  const minPct = opts.minPctChange ?? 0.05;

  const items: TrendItem[] = [];
  for (const s of series) {
    const pts = s.points.filter((p) => Number.isFinite(p.value));
    if (pts.length < 2) continue; // insufficient data
    const first = pts[0].value;
    const last = pts[pts.length - 1].value;
    const absChange = last - first;
    if (absChange === 0) continue; // flat
    const pctChange = first !== 0 ? absChange / Math.abs(first) : null;
    const { shift, lastStatus } = classifyShift(first, last, s.range);

    // Keep only meaningful moves: a big-enough relative change, or a range cross.
    const relMag = pctChange == null ? 1 : Math.abs(pctChange);
    if (relMag < minPct && shift == null) continue;

    const direction: "up" | "down" = absChange > 0 ? "up" : "down";
    const days = daysBetween(pts[0].date, pts[pts.length - 1].date);
    const magnitude = scoreOf(pctChange, shift);
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
      lastStatus,
      magnitude,
    };
    items.push({ ...core, text: buildText(core, s.unit ?? "") });
  }

  items.sort(
    (x, y) => y.magnitude - x.magnitude || x.label.localeCompare(y.label)
  );
  return items.slice(0, Math.max(0, limit));
}
