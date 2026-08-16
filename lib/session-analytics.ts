// What a WORN session's own recording says about it, for activities that are not
// rides (#3009). The stream cores these build on are already type-agnostic — a
// split is a split and a drift is a drift — so this module is the small amount of
// judgement that is NOT shared: how far apart to cut a foot session's splits, and
// what "efficiency" means when the output is pace rather than power.

import type { DistanceUnit } from "./settings";
import { numeric, booleans } from "./cycling-analytics";
import type { CyclingStreams } from "./integrations/cycling-telemetry";

// The metres in one unit of the reader's distance — the natural split for anyone
// who says "my kilometre splits" or "my mile splits".
const BASE_M: Record<DistanceUnit, number> = { km: 1000, mi: 1609.344 };

// Beyond this many rows a split table stops being read and starts being scrolled.
const MAX_SPLITS = 20;

/**
 * How far apart to cut this session's splits, in metres.
 *
 * A ride hardcodes 5 km / 5 mi (`rides/[id]/page.tsx`) because that is the
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
  return total / base > MAX_SPLITS ? base * 5 : base;
}

/**
 * Aerobic decoupling: how much the session's OUTPUT-per-heartbeat fell between
 * its first and second half. A positive percentage means the same heart rate
 * bought less in the back half — the established endurance signal for "the
 * effort cost more as it went on".
 *
 * This is the same question the ride page's power-HR drift asks, computed over
 * pace instead of power (#2566 item 2), so it is the same function: `output` is
 * whichever series the session HAS. Sampling rules matter as much as the
 * arithmetic — a stopped stretch, a coasting descent, or a heart rate below a
 * plausible working floor would each report a drift that is really an artifact:
 *
 *   - samples where the recording says NOT moving are skipped;
 *   - `minOutput` drops the coasting/standing samples the ride math already
 *     dropped at 50 W — for pace, walking speed rather than a stopped GPS jitter;
 *   - `minHr` drops resting-rate samples the same way;
 *   - both halves need `minSamples`, so a session with a gap in one half returns
 *     null rather than comparing a full half against a fragment.
 */
export function outputHrDrift(
  times: (number | null)[],
  output: (number | null)[],
  heartrate: (number | null)[],
  moving: (boolean | null)[],
  opts: { minOutput: number; minHr: number; minSamples: number }
): number | null {
  const first = { output: 0, hr: 0, count: 0 };
  const second = { output: 0, hr: 0, count: 0 };
  const stamps = times.filter((value): value is number => value != null);
  if (stamps.length === 0) return null;
  const midpoint = (stamps[0] + stamps[stamps.length - 1]) / 2;

  for (let index = 0; index < times.length; index++) {
    const time = times[index];
    const value = output[index];
    const hr = heartrate[index];
    if (
      time == null ||
      value == null ||
      value < opts.minOutput ||
      hr == null ||
      hr < opts.minHr ||
      moving[index] === false
    ) {
      continue;
    }
    const half = time <= midpoint ? first : second;
    half.output += value;
    half.hr += hr;
    half.count++;
  }
  if (first.count < opts.minSamples || second.count < opts.minSamples) {
    return null;
  }
  const firstEfficiency = first.output / first.count / (first.hr / first.count);
  const secondEfficiency =
    second.output / second.count / (second.hr / second.count);
  if (firstEfficiency <= 0) return null;
  return (
    Math.round(
      ((firstEfficiency - secondEfficiency) / firstEfficiency) * 1000
    ) / 10
  );
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
  streams: CyclingStreams
): number | null {
  return outputHrDrift(
    numeric(streams.time),
    numeric(streams.velocity_smooth),
    numeric(streams.heartrate),
    booleans(streams.moving),
    { minOutput: MIN_PACE_MPS, minHr: MIN_HR, minSamples: MIN_DRIFT_SAMPLES }
  );
}
