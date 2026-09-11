// THE metric-movement verdicts (#3394). One module owns "which way is this metric
// moving, and does that count as movement" for a dated numeric series.
//
// ── Three questions, deliberately kept apart ────────────────────────────────────
//
// The census behind #3394 found four implementations of a nominally single
// question. They were not, in fact, one question, and the first correction this
// module records is that agreement across them is MATHEMATICALLY FALSE:
//
//   [100, 100, 100, 110, 110, 110, 105]
//
// The latest move is DOWN (110 → 105). The robust window endpoints move UP
// (100 → 110). Both answers are true about the same series; they answer different
// questions. A "verdicts never disagree" invariant would force one of them to lie.
//
// So the contract is narrower and actually holds: THE SAME NAMED QUESTION, over the
// same normalized series, period/basis and materiality policy, gives the same answer
// at every consumer. Three questions live here and stay named:
//
//   - `pointToPointMovement` — "which way did the LATEST reading move" (the last two
//     readings, #1221), with the #2303 same-day suppression and a DECLARED tolerance
//     band so "flat" is a stated property of the series.
//   - `windowMovement` — "did this series move materially OVER A WINDOW" (robust
//     median endpoints, #37), with a relative materiality floor.
//   - `versusBaselineMovement` — "how does the latest reading compare with this
//     profile's USUAL" (a trailing baseline mean, #1909's `trailingAverage`), with a
//     DECLARED window basis.
//
// Tolerance belongs to the named policy, not to the module: a 0.1 kg band is right
// for a bathroom scale and meaningless for a blood pressure. Different questions
// legitimately spend different thresholds, and forcing one number on all of them
// would be the same mistake in the other direction.
//
// Not here, on purpose:
//   - `compareOutcomePooled` (`lib/protocol-compare.ts`) — a baseline WINDOW against
//     an intervention WINDOW for protocols (#5157/#5163). A fourth question
//     (before/during), not a movement verdict.
//   - `DASHBOARD_READING_PROMOTIONS` — a closed set of categorical verdict
//     transitions where raw magnitude is forbidden (#3077/#3389).
//   - `buildFitnessTile`'s `deltaArrow` — an improvement-aware better/worse arrow.
//   - `weightAnomalyToFinding` — data hygiene (a suspected kg/lb entry error).
//
// Pure and clock-free: this module reads series, never the DB.

import { populationSd, robustEndpoints } from "./robust-stats";
import {
  trailingAverage,
  type TrailingPoint,
  type TrailingWindowSpec,
} from "./trailing-average";

export type MovementDirection = "up" | "down" | "flat";

// The ONE signed-delta → direction rule, so every question above spells "flat" the
// same way and only the BAND differs. `toleranceAbs` is the half-open flat band in
// the series' own unit: a delta strictly smaller in magnitude is not movement. The
// default 0 makes any nonzero delta a direction, which is the point-to-point
// question's historical rule.
export function movementDirection(
  delta: number,
  toleranceAbs = 0
): MovementDirection {
  // Written as a POSITIVE test so a NaN delta — an unparseable reading that reached
  // here through a cast — falls to "flat" rather than to whichever arm a comparison
  // with NaN happens to leave. "No movement I can evidence" is the honest answer to a
  // delta that is not a number; `!(abs < tol)` would call it a direction.
  if (!(Math.abs(delta) >= toleranceAbs) || delta === 0) return "flat";
  return delta > 0 ? "up" : "down";
}

// ── Question 1: point to point ──────────────────────────────────────────────────

// A declared "flat" band for a series asked the point-to-point question. Weight is
// the one quantity that has ever needed one: a bathroom scale moves 50–100 g between
// two honest weigh-ins of an unchanged body, so the household card has always
// refused to draw an arrow under 0.1 kg. The constant lives HERE rather than as a
// default argument in the household module (#3394) — it is a property of the
// quantity, not of the surface that happens to render it.
export const WEIGHT_TOLERANCE_KG = 0.1;

export interface PointToPointMovement {
  date: string;
  value: number;
  // The reading immediately before the latest one, or null when the series has a
  // single reading.
  previousValue: number | null;
  // That reading's DAY, so a caller that draws the pair rather than describing it can
  // place both points on a calendar (#3252's Standing sparkline). Null exactly when
  // `previousValue` is — one reading has nothing before it.
  previousDate: string | null;
  // Direction of the latest reading versus the previous one; null with a single
  // reading, and null when the two readings share a DATE (#2303 — see below).
  direction: MovementDirection | null;
}

// The latest reading and its direction versus the prior reading. Expects the series
// ascending by date (as the series queries return); tolerates any order by taking the
// last two by position. Returns null for an empty series.
//
// Marker-agnostic and unit-agnostic — callers pass already-canonical numbers, and
// declare the quantity's flat band through `toleranceAbs` (default 0: any nonzero
// difference is a direction).
export function pointToPointMovement(
  points: readonly { date: string; value: number }[],
  opts: { toleranceAbs?: number } = {}
): PointToPointMovement | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  // A SAME-DAY pair is not a direction (#2303). Three sequential cuff readings from one
  // clinic visit share a date — ordinary clinical practice — and the two-point tail then
  // takes two of them, so the arrow claimed "up versus previous blood pressure" between
  // reading #3 and reading #2 of a single measurement. What is withdrawn is the
  // DIRECTION only: `previousValue` still reports the other reading, because the data is
  // real; the unsupported claim is that anything moved between them.
  //
  // The rule lives here, in the shared verdict, rather than in the BP branch — it is
  // marker-agnostic like the rest of this module, and it fixes FRESH data too (three cuff
  // readings taken this morning produced the same fake arrow). Only the biomarker path can
  // reach it today: getLatestBodyMetricDailyPoints already folds to one point per date.
  const sameDay = prev != null && prev.date === latest.date;
  const direction =
    prev == null || sameDay
      ? null
      : movementDirection(latest.value - prev.value, opts.toleranceAbs ?? 0);
  return {
    date: latest.date,
    value: latest.value,
    previousValue: prev ? prev.value : null,
    previousDate: prev ? prev.date : null,
    direction,
  };
}

// ── Question 2: window ──────────────────────────────────────────────────────────

// The default relative materiality floor for the window question: a move smaller
// than 5% of where the window started is not news about the window.
export const WINDOW_MIN_PCT_CHANGE = 0.05;

export interface WindowMovement {
  // Finite points the verdict was measured over.
  count: number;
  // Robust endpoint values (median of the first/last k), not the literal first/last.
  first: number;
  last: number;
  // last − first (robust), so positive = the metric rose over the window.
  absChange: number;
  // (last − first) / |first|, or null when first is 0.
  pctChange: number | null;
  direction: MovementDirection;
  // True when the relative magnitude clears the declared floor. A caller with a
  // second, categorical materiality source (a reference-range crossing) ORs it in.
  clearsMinPct: boolean;
}

// The move between ROBUST endpoints — the median of the first k and the last k
// readings, k = min(3, ⌊n/2⌋) (#37) — rather than the literal first and last points,
// so one noisy weigh-in at either end cannot define the whole trend. For a 2–3 point
// series k collapses to 1, i.e. exactly first-vs-last.
//
// `points` must be CHRONOLOGICAL (oldest → newest) — the order every body-metric /
// volume / biomarker series is shaped into before charting, and what makes "first k"
// and "last k" mean the start and end of the window. Nulls and non-finite values are
// filtered here, so a caller may pass a series with gaps. Returns null for a series
// with fewer than 2 finite points (no direction to report).
export function windowMovement(
  points: readonly { value: number | null }[],
  opts: { minPctChange?: number } = {}
): WindowMovement | null {
  const pts = points.filter(
    (p): p is { value: number } => p.value != null && Number.isFinite(p.value)
  );
  if (pts.length < 2) return null;
  const k = Math.min(3, Math.floor(pts.length / 2));
  const { first, last } = robustEndpoints(pts, k);
  const absChange = last - first;
  const pctChange = first !== 0 ? absChange / Math.abs(first) : null;
  // A zero `first` leaves no relative scale, so the move is admitted on its own
  // terms rather than measured against nothing.
  const relMag = pctChange == null ? 1 : Math.abs(pctChange);
  const minPct = opts.minPctChange ?? WINDOW_MIN_PCT_CHANGE;
  return {
    count: pts.length,
    first,
    last,
    absChange,
    pctChange,
    direction: movementDirection(absChange),
    clearsMinPct: absChange !== 0 && relMag >= minPct,
  };
}

// ── Question 3: versus baseline ─────────────────────────────────────────────────

// The shared recovery/usual baseline: the 30 most recent DATA-BEARING days before the
// day in question (#3394, absorbing #5164).
//
// THE BASIS IS THE WHOLE POINT. Sleep used to hold two baselines for one night and
// they disagreed by construction: the Sleep hero averaged the prior 30 CALENDAR days,
// the coaching signal the last 30 nights WITH DATA. On a profile with a gap those are
// different norms, so the digest's verdict about a night and the hero's delta for the
// same night were measured against different things. `trailingAverage` already carries
// `basis` as a DECLARED parameter (#1909); this is that declaration for the
// versus-baseline question, made once instead of twice by accident.
//
// Data-bearing is the right basis for "my usual": a watch that missed a week still
// yields a 30-night norm rather than a 23-night one, so the sample size is stable and
// the span is not. A period summary that PRINTS a date range wants the other basis and
// says so at its own call site.
export const USUAL_BASELINE_DAYS = 30;

export const USUAL_BASELINE_SPEC: TrailingWindowSpec = {
  days: USUAL_BASELINE_DAYS,
  basis: "data-bearing",
  includeToday: false,
};

export interface VersusBaselineMovement {
  // The day asked about, and its reading.
  date: string;
  value: number;
  // The UNROUNDED baseline mean, or null when the window holds nothing to average.
  // Rounding is presentation and stays with the caller.
  baseline: number | null;
  // How many days the baseline averaged, and the span it actually covered.
  baselineCount: number;
  baselineFrom: string | null;
  baselineTo: string | null;
  // value − baseline, so positive = above the usual. Null exactly when `baseline` is.
  delta: number | null;
  direction: MovementDirection | null;
  // TRUE when the baseline is `trailingAverage`'s DAY-ONE fallback: the series holds
  // no reading before this day at all, so `baseline` is this day's own reading and
  // `delta` is 0. A surface either QUALIFIES that or DECLINES it — the Sleep hero
  // declines (reports no baseline), the coaching signal accepts it as a neutral norm.
  // Never label it a completed-day mean.
  dayOneFallback: boolean;
  // Population spread of the SAME sample the baseline averaged, for a consumer that
  // scales its verdict by how variable this profile normally is. Undefined below two
  // days — a spread over one number is not a spread — and undefined for the day-one
  // fallback, whose "sample" is the anchor day itself.
  baselineSpread?: number;
}

// The latest reading on `anchorDate` against the profile's usual. Returns null when
// the series carries no reading dated exactly `anchorDate` — FRESHNESS IS PART OF THE
// ANSWER (#3993): the newest recorded day is not automatically the day asked about,
// and naming another day's number as this one's is worse than no signal. A present
// day with an EMPTY baseline window is not that case: it comes back with a null
// baseline, because the reading itself is still a fact.
//
// Accepts the series in any order. `spec` declares the window; pass
// `USUAL_BASELINE_SPEC` unless the surface genuinely asks a different period.
export function versusBaselineMovement<P extends TrailingPoint>(
  points: readonly P[],
  anchorDate: string,
  spec: TrailingWindowSpec = USUAL_BASELINE_SPEC
): VersusBaselineMovement | null {
  const onAnchor = points.filter((p) => p.date === anchorDate);
  if (onAnchor.length === 0) return null;
  const value = onAnchor[onAnchor.length - 1].value;
  const window = trailingAverage(points, anchorDate, spec);
  const baseline = window.average;
  const delta = baseline == null ? null : value - baseline;
  return {
    date: anchorDate,
    value,
    baseline,
    baselineCount: window.count,
    baselineFrom: window.from,
    baselineTo: window.to,
    delta,
    direction: delta == null ? null : movementDirection(delta),
    dayOneFallback: window.dayOneFallback,
    ...(window.dayOneFallback || window.count < 2
      ? {}
      : { baselineSpread: populationSd(window.points.map((p) => p.value)) }),
  };
}
