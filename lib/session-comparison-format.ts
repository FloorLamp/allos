// How a like-for-like comparison metric READS: its unit, its display value, and
// the sentence its difference makes ("2.1 km/h above 9.6 km/h median").
//
// These lived privately in the ride page. They move here because #2566's
// convergence gives the comparison ONE presentation across every session type
// (owner ruling, 2026-08-16), and because the rule they carry is a judgement
// worth testing rather than four ternaries buried in a 1,400-line page:
//
//   ONLY SPEED HAS A DIRECTION. More heart rate, power, elevation, cadence or
//   relative effort is CONTEXT, not an achievement — a session run at a higher
//   heart rate for the same pace is not a better session, and colouring it as
//   one tells a reader something untrue about their own body. The ride page knew
//   this; the plain rows that shipped first for walks did not, and toned every
//   metric by direction (#3023). This is the fix, made shared so it cannot be
//   lost again.

import { kmTo, round } from "./units";
import type { DistanceUnit } from "./settings";
import type {
  SessionComparisonMetric,
  SessionComparisonMetricKey,
} from "./session-detail";

// Metres to feet, for the one metric stored in metres but read in feet.
const FEET_PER_METRE = 3.28084;

export function comparisonUnitSuffix(
  key: SessionComparisonMetricKey,
  distanceUnit: DistanceUnit
): string {
  switch (key) {
    case "speed":
      return ` ${distanceUnit}/h`;
    case "heart_rate":
      return " bpm";
    case "power":
    case "weighted_power":
      return " W";
    case "cadence":
      return " rpm";
    case "elevation":
      return distanceUnit === "mi" ? " ft" : " m";
    default:
      return "";
  }
}

// The stored value in the reader's units — the number a chart plots and a label
// formats, so both can never disagree about the conversion.
export function comparisonDisplayValue(
  key: SessionComparisonMetricKey,
  value: number,
  distanceUnit: DistanceUnit
): number {
  if (key === "speed") return kmTo(value, distanceUnit);
  if (key === "elevation" && distanceUnit === "mi")
    return value * FEET_PER_METRE;
  return value;
}

// How many decimals this metric earns: speed and relative effort are read to a
// tenth; a heart rate of 152.4 bpm is false precision.
export function comparisonDecimals(key: SessionComparisonMetricKey): number {
  return key === "speed" || key === "relative_effort" ? 1 : 0;
}

export function formatComparisonValue(
  key: SessionComparisonMetricKey,
  value: number,
  distanceUnit: DistanceUnit
): string {
  const shown = comparisonDisplayValue(key, value, distanceUnit);
  const decimals = comparisonDecimals(key);
  const rounded = decimals > 0 ? round(shown, decimals) : Math.round(shown);
  return `${rounded}${comparisonUnitSuffix(key, distanceUnit)}`;
}

export interface ComparisonDifference {
  // Null when the difference rounds to nothing at this metric's precision — the
  // reader is told "same as", not "0 bpm above".
  value: string | null;
  relation: "above" | "below" | "same as";
}

export function comparisonDifference(
  metric: SessionComparisonMetric,
  distanceUnit: DistanceUnit
): ComparisonDifference {
  const shown = comparisonDisplayValue(
    metric.key,
    metric.difference,
    distanceUnit
  );
  const decimals = comparisonDecimals(metric.key);
  const rounded = decimals > 0 ? round(shown, decimals) : Math.round(shown);
  if (rounded === 0) return { value: null, relation: "same as" };
  return {
    value: `${Math.abs(rounded)}${comparisonUnitSuffix(metric.key, distanceUnit)}`,
    relation: rounded > 0 ? "above" : "below",
  };
}

// Whether being ABOVE the peer median is an achievement for this metric. Speed
// alone answers yes. Everything else is context — see the module header.
export function comparisonHasDirection(
  key: SessionComparisonMetricKey
): boolean {
  return key === "speed";
}

export type ComparisonTone = "good" | "watch" | "neutral";

// The tone a difference earns. A metric with no direction is always neutral, no
// matter how far from the median it sits.
export function comparisonTone(
  metric: SessionComparisonMetric,
  relation: ComparisonDifference["relation"]
): ComparisonTone {
  if (!comparisonHasDirection(metric.key)) return "neutral";
  if (relation === "above") return "good";
  if (relation === "below") return "watch";
  return "neutral";
}
