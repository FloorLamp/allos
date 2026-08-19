// The continuous-glucose TRACE model — pure (no DB, no clock, no timezone math).
//
// WHAT THIS IS AND IS NOT (issue #2810; the ruling is in
// docs/internals/reading-model.md, "Where continuous glucose belongs").
//
// A CGM emits ~288 interstitial readings a day. The reading model covers dated
// readings ABOVE minute grain, so a trace point is NOT a `Reading`: it has no
// canonical identity, no provenance, no band and no fold. It lives in its own
// narrow instant-keyed table (`glucose_trace`), on `hr_minutes`' side of the grain
// boundary.
//
// What IS above the boundary is the once-a-day summary the trace supports, and
// that is what this module computes: the day's mean glucose, its time in range,
// and the point count behind both. Those are `metric_samples` metrics — the same
// shape `hr_minutes` already rolls up into for the figures surfaces read.
//
// UNITS: mg/dL throughout, the canonical storage unit for glucose in this app (the
// curated vocabulary's `Glucose` entry, and what the Health Connect ingest already
// converts mmol/L into). Conversion is a display-boundary concern.

// The consensus target range for time-in-range, mg/dL, inclusive at both ends.
//
// 70–180 is the international consensus (Battelino et al. 2019) for non-pregnant
// adults with type 1 or type 2 diabetes, and is the range every CGM report prints.
// It is a TARGET, not a reference band, and that distinction is the whole reason a
// number derived here is safe where a `Glucose` reading's band was not: #2337 ruled
// the unqualified `Glucose` entry band-less because the draw's fasting frame was
// never stated. Time-in-range asks a different question — "how much of the day did
// this person spend inside their therapeutic target" — which does not depend on the
// frame of any single point, precisely because it is computed over ALL of them.
export const GLUCOSE_TARGET_LOW_MGDL = 70;
export const GLUCOSE_TARGET_HIGH_MGDL = 180;

// The `metric_samples` metric keys the daily derivations are stored under.
//
// NAMED FOR THE TRACE, NEVER FOR THE ANALYTE. There is deliberately no bare
// `glucose_mgdl` metric (the key the issue proposed): a metric key is one half of
// what `READING_IDENTITY_MAP` would register as a stream of a canonical name, and
// registering a continuous interstitial trace under `Glucose` would fold it into
// the same identity as a fasting venous draw — the frame #2337 refused to commit
// and #2799's `frameUnstatedNames` exists to keep refusing. These three keys are
// summaries OF a trace, not readings of an analyte, and none of them is registered
// as a stream. Which curated entry (if any) a CGM reading should map to is a
// CURATION decision and is not made here.
export const GLUCOSE_MEAN_METRIC = "glucose_mean_mgdl";
export const GLUCOSE_TIME_IN_RANGE_METRIC = "glucose_time_in_range_pct";
export const GLUCOSE_TRACE_POINTS_METRIC = "glucose_trace_points";

export const GLUCOSE_DERIVED_METRICS = [
  GLUCOSE_MEAN_METRIC,
  GLUCOSE_TIME_IN_RANGE_METRIC,
  GLUCOSE_TRACE_POINTS_METRIC,
] as const;

/** One stored trace point: an absolute instant and the sensor's mg/dL. */
export interface GlucoseTracePoint {
  ts: string;
  mgdl: number;
}

/** One profile-local day's summary of the trace. */
export interface GlucoseDayDerivation {
  /** Mean sensor glucose, mg/dL, to one decimal. */
  meanMgdl: number;
  /**
   * Percent of the day's points inside [70, 180], to one decimal.
   *
   * A FRACTION OF POINTS, not of clock time, and the difference is worth stating
   * because the name says "time". They are the same number when the sensor's
   * cadence is even, which is what a CGM's is by construction, and they diverge
   * exactly when it is not — a day with a six-hour warm-up gap weights its dense
   * stretch more heavily than the clock would. Reconstructing true clock time would
   * mean attributing each gap to a value nobody measured, which is a bigger claim
   * than the honest one; `points` is published beside this so a reader can see how
   * much of the day is actually behind the number instead of inferring it.
   */
  timeInRangePct: number;
  /** How many trace points the day held. The coverage figure for the two above. */
  points: number;
}

// Round to one decimal without the float tail (0.1 + 0.2 arithmetic reaching a
// stored value would make an idempotent recompute look like an update).
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The day's derivations, or null when the day held no points at all.
 *
 * Null rather than zeros: a day with no sensor data has no mean and no
 * time-in-range, and writing 0% would read as "spent the whole day out of range",
 * which is the same class of error as flagging a value against a frame nobody
 * stated. A gap stays a gap.
 */
export function deriveGlucoseDay(
  points: readonly GlucoseTracePoint[]
): GlucoseDayDerivation | null {
  if (points.length === 0) return null;
  let total = 0;
  let inRange = 0;
  for (const p of points) {
    total += p.mgdl;
    if (p.mgdl >= GLUCOSE_TARGET_LOW_MGDL && p.mgdl <= GLUCOSE_TARGET_HIGH_MGDL)
      inRange++;
  }
  return {
    meanMgdl: round1(total / points.length),
    timeInRangePct: round1((inRange * 100) / points.length),
    points: points.length,
  };
}
