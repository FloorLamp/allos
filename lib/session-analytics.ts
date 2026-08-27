// What a WORN session's own recording says about it, for activities that are not
// rides (#3009). The stream cores these build on are already type-agnostic — a
// split is a split and a drift is a drift — so this module is the small amount of
// judgement that is NOT shared: how far apart to cut a foot session's splits, and
// what "efficiency" means when the output is pace rather than power.

import type { DistanceUnit } from "./settings";
import { numeric, booleans, outputHrDrift } from "./cycling-analytics";
import type { ActivityStreams } from "./integrations/activity-telemetry";

// The metres in one unit of the reader's distance — the natural split for anyone
// who says "my kilometre splits" or "my mile splits".
const BASE_M: Record<DistanceUnit, number> = { km: 1000, mi: 1609.344 };

// Beyond this many rows a split table stops being read and starts being scrolled.
const MAX_SPLITS = 20;

/**
 * How far apart to cut this session's splits, in metres.
 *
 * A ride uses 5 km / 5 mi on the canonical activity detail because that is the
 * distance a ride is discussed in. A walk of 1.4 km would produce NO splits at
 * that interval — the core declines anything under a third of one — and a
 * marathon would produce 42 rows at 1 km. So the interval is the reader's own
 * unit, stepped up to 5 of them once one-per-unit would overflow the table.
 */
export function sessionSplitIntervalM(
  totalDistanceKm: number | null,
  unit: DistanceUnit
): number {
  const base = BASE_M[unit];
  const total = (totalDistanceKm ?? 0) * 1000;
  // Step up until the table fits, rather than exactly once: a single ×5 held the
  // bound only to a hundred units, and an ultra would still have rendered thirty
  // rows. Each step is ×5 so the interval stays a number people say out loud
  // (1, 5, 25 km).
  let interval = base;
  while (total / interval > MAX_SPLITS) interval *= 5;
  return interval;
}

// The distance the RECORDING actually covers, in km — the same series the splits
// are cut from. Null when the session stored no distance stream, which is when
// the caller should fall back to the activity's own summary column.
export function streamDistanceKm(streams: ActivityStreams): number | null {
  const distance = numeric(streams.distance);
  for (let index = distance.length - 1; index >= 0; index--) {
    const metres = distance[index];
    if (metres != null) return metres / 1000;
  }
  return null;
}

// Walking pace as the floor: below this the recording is a stopped GPS wandering,
// not a session getting slower. In m/s, the unit `velocity_smooth` carries.
const MIN_PACE_MPS = 0.8;
// The same working-heart-rate floor the ride math uses.
const MIN_HR = 60;
// One sample a second for half a minute in each half — enough that a drift is a
// trend rather than two noisy readings.
const MIN_DRIFT_SAMPLES = 30;

// Pace-HR decoupling for a session that recorded speed and heart rate. Null
// whenever the recording cannot answer, which is most walks: the question needs
// both series, moving for long enough, in both halves.
export function paceHrDecouplingPercent(
  streams: ActivityStreams
): number | null {
  return outputHrDrift(
    numeric(streams.time),
    numeric(streams.velocity_smooth),
    numeric(streams.heartrate),
    booleans(streams.moving),
    { minOutput: MIN_PACE_MPS, minHr: MIN_HR, minSamples: MIN_DRIFT_SAMPLES }
  );
}
