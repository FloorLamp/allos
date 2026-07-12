// Biomarker trajectory rules (issue #41). Pure, no DB/network. Where
// `reconciledFlag` (lib/reference-range) classifies ONE value and the trends
// digest only reacts AFTER a range crossing, these rules look at the SHAPE of a
// per-analyte series over time and warn BEFORE the crossing:
//
//   1. Approaching boundary — the value is still in range, but the robust
//      (Theil–Sen) slope projects it crossing the reference (or optimal) boundary
//      within a horizon of ≈2× the analyte's retest interval.
//   2. Persistent non-optimal — the same non-optimal/out-of-range status on the
//      last N=3 consecutive tests spanning ≥90 days (a drift a single-value flag
//      keeps re-flagging but never escalates).
//   3. Velocity — change-per-time in the analyte's "bad" direction exceeding a
//      curated per-analyte threshold, even while the value is still in range
//      (curated conservatively: eGFR decline, PSA rise — see VELOCITY_PER_YEAR in
//      scripts/gen-canonical-biomarkers).
//
// Each rule that fires returns a Finding (lib/findings) with a stable
// dedupeKey `trajectory:<analyte>:<rule>`, so the generalized suppression store
// silences it exactly like any other finding. The medical tone is observational —
// numbers shown, "worth discussing with your clinician" framing — never advice.
//
// The Theil–Sen slope tolerates a minority of outlier readings; every rule also
// requires ≥3 points and a ≥60-day span so a couple of same-week draws can't
// invent a trajectory. Robustness math lives in lib/robust-stats.

import { type DatedPoint, theilSenSlopePerDay } from "./robust-stats";
import { daysBetween, humanizeAge, referenceStatus } from "./reference-range";
import { round } from "./units";
import type { BiomarkerDirection } from "./types";
import type { Finding } from "./findings";
import type { AppRoute } from "./hrefs";

// ---- Thresholds (exported so the tests pin the exact boundaries) ----

// A rule needs at least this many readings…
export const MIN_POINTS = 3;
// …spanning at least this many days (first → last), so a same-week cluster can't
// look like a trend.
export const MIN_SPAN_DAYS = 60;
// The approaching-boundary horizon is this multiple of the analyte's retest
// interval: a crossing projected within ~2 retest cycles is worth surfacing now.
export const HORIZON_RETEST_MULTIPLE = 2;
// Persistence: this many consecutive most-recent readings…
export const PERSIST_COUNT = 3;
// …spanning at least this many days, all sharing the same non-optimal status.
export const PERSIST_SPAN_DAYS = 90;
// At/above this many readings a projected crossing reads as reasonably supported;
// BELOW it the approaching-boundary copy hedges the ETA as a "rough estimate"
// (issue #563), matching the goal-projection confidence tier (lib/trend-projection,
// CONFIDENT_MIN_POINTS = 5). A 4-point projection stated as a firm multi-year ETA
// overclaims; the hedge keeps the copy honest about the sample size.
export const CONFIDENT_MIN_POINTS = 5;
// Days per year for the velocity conversion (Julian year, matching robust-stats).
const DAYS_PER_YEAR = 365.25;

export type TrajectoryRule = "approaching" | "persistent" | "velocity";

// A plain, already-resolved [low, high] band in the SAME unit as the points
// (nulls = open bound). The caller resolves sex/age/status into these numbers so
// the engine stays pure.
export interface Band {
  low: number | null;
  high: number | null;
}

export interface TrajectoryInput {
  // Canonical analyte name — both the dedupeKey suffix and the label.
  analyte: string;
  // Display unit suffix without a leading space (e.g. "mg/dL"); omitted for
  // unitless analytes.
  unit?: string | null;
  // Chronological (oldest → newest) finite readings in a single unit.
  points: DatedPoint[];
  // Effective reference / optimal bands in the points' unit, or null when the
  // analyte has none.
  reference: Band | null;
  optimal: Band | null;
  direction: BiomarkerDirection;
  // Resolved retest interval in days (already defaulted; drives the horizon).
  retestDays: number;
  // Curated velocity threshold (canonical units/year); null/absent = no velocity
  // rule for this analyte.
  velocityPerYear?: number | null;
  // Smallest total change (in the points' unit) that counts as signal rather than
  // measurement noise (issue #563, lib/biomarker-noise-floor). The approaching-
  // boundary rule won't fire unless the fitted change OR the observed value range
  // clears this floor — so a 1-unit SpO2 wiggle inside the device's ±2 error
  // doesn't project a confident decline. null/absent = no floor (the pure engine's
  // default; the assembly always derives and supplies one).
  noiseFloor?: number | null;
  // Today (YYYY-MM-DD) — only used to keep humanized spans/projections stable.
  today: string;
  // Optional detail-page link ("schedule a retest" affordance).
  href?: AppRoute;
}

// Where a single value sits, combining the reference range and the optimal band.
// The non-good statuses (everything but "optimal"/"unknown") are what the
// persistence rule tracks.
export type ValueStatus =
  "high" | "low" | "above-optimal" | "below-optimal" | "optimal" | "unknown";

// Structured evidence attached to every trajectory finding (points + slope),
// carried alongside the Finding envelope for surfaces/tests that want the numbers.
export interface TrajectoryEvidence {
  rule: TrajectoryRule;
  points: DatedPoint[];
  count: number;
  spanDays: number;
  latest: number;
  // Robust slope expressed per YEAR (null when undefined — used by approaching +
  // velocity, null for persistence).
  slopePerYear: number | null;
  // Approaching-boundary only: the boundary being approached and the projected
  // days until the value crosses it.
  boundary?: number;
  boundaryKind?: "reference" | "optimal";
  projectedDays?: number;
}

export interface TrajectoryFinding extends Finding {
  rule: TrajectoryRule;
  evidenceData: TrajectoryEvidence;
}

// Classify one value against the reference range then the optimal band, honoring
// direction. Out-of-range (high/low) dominates; inside the range, a value outside
// the direction-relevant optimal bound is above/below-optimal; otherwise optimal.
// "unknown" only when there are no bounds at all to judge against.
export function classifyValue(
  value: number,
  reference: Band | null,
  optimal: Band | null,
  direction: BiomarkerDirection
): ValueStatus {
  const ref = reference ?? { low: null, high: null };
  const rs = referenceStatus(value, ref.low, ref.high);
  if (rs === "above") return "high";
  if (rs === "below") return "low";
  const opt = optimal ?? { low: null, high: null };
  const hasOpt = opt.low != null || opt.high != null;
  if (direction === "higher_better") {
    if (opt.low != null && value < opt.low) return "below-optimal";
  } else if (direction === "lower_better") {
    if (opt.high != null && value > opt.high) return "above-optimal";
  } else {
    if (opt.low != null && value < opt.low) return "below-optimal";
    if (opt.high != null && value > opt.high) return "above-optimal";
  }
  if (rs === "in") return "optimal";
  // rs === "unknown": no reference bounds — optimal iff an optimal bound placed it.
  return hasOpt ? "optimal" : "unknown";
}

// Format a number compactly for prose: at most 2 decimals, trailing zeros dropped.
function fmt(n: number): string {
  return String(round(n, 2));
}

function unitSuffix(unit: string | null | undefined): string {
  return unit && unit.trim() ? ` ${unit.trim()}` : "";
}

// A human phrase for a non-optimal status ("above the optimal range", …).
function statusPhrase(status: ValueStatus): string {
  switch (status) {
    case "high":
      return "above the reference range";
    case "low":
      return "below the reference range";
    case "above-optimal":
      return "above the optimal range";
    case "below-optimal":
      return "below the optimal range";
    default:
      return "";
  }
}

const NON_GOOD: ReadonlySet<ValueStatus> = new Set([
  "high",
  "low",
  "above-optimal",
  "below-optimal",
]);

function baseFinding(
  input: TrajectoryInput,
  rule: TrajectoryRule
): Pick<
  Finding,
  "domain" | "dedupeKey" | "tone" | "actionHref" | "actionLabel"
> {
  return {
    domain: "trajectory",
    dedupeKey: `trajectory:${input.analyte}:${rule}`,
    tone: "caution",
    ...(input.href
      ? { actionHref: input.href, actionLabel: "Schedule a retest" }
      : {}),
  };
}

// Rule 1 — approaching boundary. In range now, but the slope projects a crossing
// within the horizon. Returns null unless a concerning boundary is on track to be
// crossed in the analyte's "bad" direction inside 2× its retest interval.
function approachingBoundary(
  input: TrajectoryInput,
  slopePerDay: number,
  spanDays: number
): TrajectoryFinding | null {
  const { points, reference, optimal, direction } = input;
  const latest = points[points.length - 1].value;
  // Only warn while still in range — an already-out-of-range value is a crossing
  // the digest/flags already report.
  const latestStatus = classifyValue(latest, reference, optimal, direction);
  if (latestStatus === "high" || latestStatus === "low") return null;
  if (slopePerDay === 0) return null;

  // Measurement-noise floor (#563): if BOTH the total fitted change over the
  // observed window and the observed value range sit at/under the analyte's noise
  // floor, the "trend" is jitter within device/assay error — don't project off it.
  // Either exceeding the floor is enough to treat the move as real signal.
  const floor = input.noiseFloor;
  if (floor != null && floor > 0) {
    const fittedChange = Math.abs(slopePerDay) * spanDays;
    const values = points.map((p) => p.value);
    const observedRange = Math.max(...values) - Math.min(...values);
    if (fittedChange <= floor && observedRange <= floor) return null;
  }

  const rising = slopePerDay > 0;
  // The slope must move in the analyte's harmful direction.
  if (direction === "higher_better" && rising) return null;
  if (direction === "lower_better" && !rising) return null;

  // Candidate boundaries beyond the current value in the direction of travel;
  // pick the NEAREST (the one it reaches first).
  const ref = reference ?? { low: null, high: null };
  const opt = optimal ?? { low: null, high: null };
  const candidates: { value: number; kind: "reference" | "optimal" }[] = [];
  if (rising) {
    if (opt.high != null && opt.high > latest)
      candidates.push({ value: opt.high, kind: "optimal" });
    if (ref.high != null && ref.high > latest)
      candidates.push({ value: ref.high, kind: "reference" });
  } else {
    if (opt.low != null && opt.low < latest)
      candidates.push({ value: opt.low, kind: "optimal" });
    if (ref.low != null && ref.low < latest)
      candidates.push({ value: ref.low, kind: "reference" });
  }
  if (candidates.length === 0) return null;
  const target = rising
    ? candidates.reduce((a, b) => (b.value < a.value ? b : a))
    : candidates.reduce((a, b) => (b.value > a.value ? b : a));

  const projectedDays = (target.value - latest) / slopePerDay;
  if (!(projectedDays > 0)) return null;
  const horizon = HORIZON_RETEST_MULTIPLE * input.retestDays;
  if (projectedDays > horizon) return null;

  const u = unitSuffix(input.unit);
  const side = rising ? "high" : "low";
  const boundaryWord =
    target.kind === "reference" ? "reference range" : "optimal range";
  const verb = rising ? "rising" : "falling";
  const first = points[0].value;
  const slopePerYear = slopePerDay * DAYS_PER_YEAR;

  const title = `${input.analyte} is trending toward its ${side} ${
    target.kind === "reference" ? "reference" : "optimal"
  } boundary`;
  // Low-confidence hedge (#563): fewer than CONFIDENT_MIN_POINTS readings can't
  // support a firm ETA, so soften "is projected to cross … in about X" to "could
  // reach … in roughly X — a rough estimate from N readings", mirroring the
  // narrative path's hedge instead of overclaiming a confident multi-year date.
  const lowConfidence = points.length < CONFIDENT_MIN_POINTS;
  const etaClause = lowConfidence
    ? `at this rate could reach the ${side} ${boundaryWord} (${fmt(
        target.value
      )}${u}) in roughly ${humanizeAge(
        Math.round(projectedDays)
      )} — a rough estimate from just ${points.length} readings`
    : `at this rate is projected to cross the ${side} ${boundaryWord} (${fmt(
        target.value
      )}${u}) in about ${humanizeAge(Math.round(projectedDays))}`;
  const detail =
    `${input.analyte} has been ${verb} — from ${fmt(first)} to ${fmt(latest)}${u} ` +
    `over ${humanizeAge(spanDays)} — and ${etaClause}. It is still in range now; ` +
    `worth discussing with your clinician.`;

  return {
    ...baseFinding(input, "approaching"),
    // Approaching a mere OPTIMAL edge (still optimal, still in reference range)
    // is the mildest signal here — tone it as informational so the amber
    // "caution" treatment stays reserved for reference-boundary approaches.
    ...(target.kind === "optimal" ? { tone: "info" as const } : {}),
    rule: "approaching",
    title,
    detail,
    evidence: `${points.length} readings over ${humanizeAge(spanDays)} · ${
      slopePerYear > 0 ? "+" : ""
    }${fmt(slopePerYear)}${u}/yr`,
    evidenceData: {
      rule: "approaching",
      points,
      count: points.length,
      spanDays,
      latest,
      slopePerYear,
      boundary: target.value,
      boundaryKind: target.kind,
      projectedDays: Math.round(projectedDays),
    },
  };
}

// Rule 2 — persistent non-optimal. The last N consecutive readings all share the
// same non-optimal/out-of-range status and span ≥90 days.
function persistentNonOptimal(
  input: TrajectoryInput
): TrajectoryFinding | null {
  const { points, reference, optimal, direction } = input;
  if (points.length < PERSIST_COUNT) return null;
  const recent = points.slice(points.length - PERSIST_COUNT);
  const span = daysBetween(recent[0].date, recent[recent.length - 1].date);
  if (span < PERSIST_SPAN_DAYS) return null;

  const statuses = recent.map((p) =>
    classifyValue(p.value, reference, optimal, direction)
  );
  const status = statuses[0];
  if (!NON_GOOD.has(status)) return null;
  if (!statuses.every((s) => s === status)) return null;

  const u = unitSuffix(input.unit);
  const latest = recent[recent.length - 1].value;
  const phrase = statusPhrase(status);

  const title = `${input.analyte} has stayed ${phrase} across your last ${PERSIST_COUNT} tests`;
  const detail =
    `Your last ${PERSIST_COUNT} ${input.analyte} readings — over ${humanizeAge(
      span
    )} — have all been ${phrase} (most recent ${fmt(latest)}${u}). ` +
    `A persistent pattern, rather than a one-off, is worth discussing with your clinician.`;

  return {
    ...baseFinding(input, "persistent"),
    rule: "persistent",
    title,
    detail,
    evidence: `${PERSIST_COUNT} consecutive readings over ${humanizeAge(span)} · all ${phrase}`,
    evidenceData: {
      rule: "persistent",
      points: recent,
      count: PERSIST_COUNT,
      spanDays: span,
      latest,
      slopePerYear: null,
    },
  };
}

// Rule 3 — velocity. Change-per-year in the analyte's harmful direction exceeds
// the curated threshold, even while the value is still in range.
function velocity(
  input: TrajectoryInput,
  slopePerDay: number,
  spanDays: number
): TrajectoryFinding | null {
  const threshold = input.velocityPerYear;
  if (threshold == null || !(threshold > 0)) return null;
  const slopePerYear = slopePerDay * DAYS_PER_YEAR;
  const { direction } = input;

  let fires = false;
  if (direction === "higher_better") fires = slopePerYear < -threshold;
  else if (direction === "lower_better") fires = slopePerYear > threshold;
  else fires = Math.abs(slopePerYear) > threshold;
  if (!fires) return null;

  const u = unitSuffix(input.unit);
  const rising = slopePerYear > 0;
  const verb = rising ? "rising" : "falling";
  const points = input.points;
  const first = points[0].value;
  const latest = points[points.length - 1].value;

  const title = `${input.analyte} is ${verb} faster than usual`;
  const detail =
    `${input.analyte} has been ${verb} about ${fmt(Math.abs(slopePerYear))}${u} per year ` +
    `(from ${fmt(first)} to ${fmt(latest)}${u} over ${humanizeAge(spanDays)}) — steeper than ` +
    `the ~${fmt(threshold)}${u}/yr that's generally worth a closer look, even though it's ` +
    `still within range. Worth discussing with your clinician.`;

  return {
    ...baseFinding(input, "velocity"),
    rule: "velocity",
    title,
    detail,
    evidence: `${points.length} readings over ${humanizeAge(spanDays)} · ${
      rising ? "+" : ""
    }${fmt(slopePerYear)}${u}/yr (threshold ${fmt(threshold)}${u}/yr)`,
    evidenceData: {
      rule: "velocity",
      points,
      count: points.length,
      spanDays,
      latest,
      slopePerYear,
    },
  };
}

// Evaluate all trajectory rules for ONE analyte's series. Returns 0..3 findings
// (one per rule that fires), ordered approaching → persistent → velocity. Shared
// gates (≥MIN_POINTS readings, ≥MIN_SPAN_DAYS span) apply to every rule; each rule
// adds its own thresholds. A flat series or too-few points yields nothing.
export function analyteTrajectoryFindings(
  input: TrajectoryInput
): TrajectoryFinding[] {
  const points = input.points.filter((p) => Number.isFinite(p.value));
  if (points.length < MIN_POINTS) return [];
  const spanDays = daysBetween(points[0].date, points[points.length - 1].date);
  if (spanDays < MIN_SPAN_DAYS) return [];
  const normalized: TrajectoryInput = { ...input, points };

  const slope = theilSenSlopePerDay(points);
  const out: TrajectoryFinding[] = [];
  if (slope != null) {
    const a = approachingBoundary(normalized, slope, spanDays);
    if (a) out.push(a);
  }
  const p = persistentNonOptimal(normalized);
  if (p) out.push(p);
  if (slope != null) {
    const v = velocity(normalized, slope, spanDays);
    if (v) out.push(v);
  }
  return out;
}

// Evaluate every analyte and flatten. Order follows the input order, then the
// per-analyte rule order.
export function trajectoryFindings(
  inputs: readonly TrajectoryInput[]
): TrajectoryFinding[] {
  return inputs.flatMap((i) => analyteTrajectoryFindings(i));
}
