import { decodePolyline, routeBounds, type LatLng } from "./polyline";
import type {
  CyclingStreams,
  TelemetryStream,
} from "./integrations/cycling-telemetry";

export type RideTraceKey =
  | "watts"
  | "cadence"
  | "velocity_smooth"
  | "altitude"
  | "heartrate"
  | "grade_smooth"
  | "temp";

export interface RideTrace {
  key: RideTraceKey;
  label: string;
  shortLabel: string;
  unit: string;
  decimals: number;
  points: { date: string; value: number | null }[];
}

export interface RideTimedRoutePoint {
  elapsedSec: number;
  lat: number;
  lng: number;
}

export interface PowerCurvePoint {
  seconds: number;
  label: string;
  watts: number;
}

export interface CyclingLoad {
  ftpW: number;
  weightedPowerW: number;
  intensityFactor: number;
  trainingLoad: number;
}

export interface PowerZoneRange {
  min: number | null;
  max: number | null;
}

export interface PowerZoneTime extends PowerZoneRange {
  zone: number;
  seconds: number;
  percent: number;
}

export interface RideDynamics {
  movingSeconds: number | null;
  stoppedSeconds: number | null;
  coastingSeconds: number | null;
  coastingPercent: number | null;
  climbingSeconds: number | null;
  climbingPercent: number | null;
  powerHrDriftPercent: number | null;
}

export interface RideDistanceSplit {
  index: number;
  distanceM: number;
  timeSec: number;
  averageSpeedKmh: number;
  averageWatts: number | null;
  averageHeartrate: number | null;
  elevationGainM: number | null;
}

const TRACE_META: Record<
  RideTraceKey,
  { label: string; shortLabel: string; unit: string; decimals: number }
> = {
  watts: { label: "Power", shortLabel: "Power", unit: " W", decimals: 0 },
  cadence: {
    label: "Cadence",
    shortLabel: "Cadence",
    unit: " rpm",
    decimals: 0,
  },
  velocity_smooth: {
    label: "Speed",
    shortLabel: "Speed",
    unit: " km/h",
    decimals: 1,
  },
  altitude: {
    label: "Elevation",
    shortLabel: "Elevation",
    unit: " m",
    decimals: 0,
  },
  heartrate: {
    label: "Heart rate",
    shortLabel: "Heart rate",
    unit: " bpm",
    decimals: 0,
  },
  grade_smooth: {
    label: "Grade",
    shortLabel: "Grade",
    unit: "%",
    decimals: 1,
  },
  temp: {
    label: "Temperature",
    shortLabel: "Temperature",
    unit: " °C",
    decimals: 1,
  },
};

export function parseCyclingStreams(value: string | null): CyclingStreams {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const out: CyclingStreams = {};
    for (const key of Object.keys(TRACE_META) as RideTraceKey[]) {
      const stream = parsed[key];
      if (!stream || typeof stream !== "object") continue;
      const data = (stream as Record<string, unknown>).data;
      if (Array.isArray(data)) out[key] = { data };
    }
    const time = parsed.time;
    if (time && typeof time === "object") {
      const data = (time as Record<string, unknown>).data;
      if (Array.isArray(data)) out.time = { data };
    }
    const distance = parsed.distance;
    if (distance && typeof distance === "object") {
      const data = (distance as Record<string, unknown>).data;
      if (Array.isArray(data)) out.distance = { data };
    }
    const moving = parsed.moving;
    if (moving && typeof moving === "object") {
      const data = (moving as Record<string, unknown>).data;
      if (Array.isArray(data)) out.moving = { data };
    }
    const latlng = parsed.latlng;
    if (latlng && typeof latlng === "object") {
      const data = (latlng as Record<string, unknown>).data;
      if (Array.isArray(data)) out.latlng = { data };
    }
    return out;
  } catch {
    return {};
  }
}

function booleans(stream: TelemetryStream | undefined): (boolean | null)[] {
  return (stream?.data ?? []).map((value) =>
    typeof value === "boolean" ? value : null
  );
}

function averageRange(
  values: (number | null)[],
  start: number,
  end: number,
  predicate?: (value: number) => boolean
): number | null {
  let sum = 0;
  let count = 0;
  for (let index = start; index <= end && index < values.length; index++) {
    const value = values[index];
    if (value != null && (!predicate || predicate(value))) {
      sum += value;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

function intervalSeconds(times: (number | null)[], index: number): number {
  const before = times[index - 1];
  const current = times[index];
  if (before == null || current == null) return 0;
  const delta = current - before;
  // Provider streams are normally one-second resolution. Ignore a malformed or
  // sparse gap rather than turning it into minutes of invented coasting/climbing.
  return delta > 0 && delta <= 30 ? delta : 0;
}

export function rideDynamics(streams: CyclingStreams): RideDynamics | null {
  const times = numeric(streams.time);
  if (times.length < 2) return null;
  const moving = booleans(streams.moving);
  const watts = numeric(streams.watts);
  const grade = numeric(streams.grade_smooth);
  const heartrate = numeric(streams.heartrate);
  const hasMoving = moving.some((value) => value != null);
  const hasWatts = watts.some((value) => value != null);
  const hasGrade = grade.some((value) => value != null);

  let movingSeconds = 0;
  let stoppedSeconds = 0;
  let coastingSeconds = 0;
  let climbingSeconds = 0;
  for (let index = 1; index < times.length; index++) {
    const seconds = intervalSeconds(times, index);
    if (seconds === 0) continue;
    const isMoving = moving[index] !== false;
    if (hasMoving) {
      if (isMoving) movingSeconds += seconds;
      else stoppedSeconds += seconds;
    }
    if (isMoving && hasWatts && watts[index] != null && watts[index]! <= 10) {
      coastingSeconds += seconds;
    }
    if (isMoving && hasGrade && grade[index] != null && grade[index]! >= 3) {
      climbingSeconds += seconds;
    }
  }

  const firstTime = times.find((value): value is number => value != null);
  const lastTime = [...times]
    .reverse()
    .find((value): value is number => value != null);
  const midpoint =
    firstTime != null && lastTime != null ? (firstTime + lastTime) / 2 : null;
  let firstPower = 0;
  let firstHr = 0;
  let firstCount = 0;
  let secondPower = 0;
  let secondHr = 0;
  let secondCount = 0;
  if (midpoint != null && hasWatts) {
    for (let index = 0; index < times.length; index++) {
      const time = times[index];
      const power = watts[index];
      const hr = heartrate[index];
      if (
        time == null ||
        power == null ||
        power < 50 ||
        hr == null ||
        hr < 60 ||
        moving[index] === false
      ) {
        continue;
      }
      if (time <= midpoint) {
        firstPower += power;
        firstHr += hr;
        firstCount++;
      } else {
        secondPower += power;
        secondHr += hr;
        secondCount++;
      }
    }
  }
  let powerHrDriftPercent: number | null = null;
  if (firstCount >= 30 && secondCount >= 30) {
    const firstEfficiency = firstPower / firstCount / (firstHr / firstCount);
    const secondEfficiency =
      secondPower / secondCount / (secondHr / secondCount);
    if (firstEfficiency > 0) {
      powerHrDriftPercent =
        Math.round(
          ((firstEfficiency - secondEfficiency) / firstEfficiency) * 1000
        ) / 10;
    }
  }

  const effectiveMovingSeconds = hasMoving
    ? movingSeconds
    : Math.max(0, (lastTime ?? 0) - (firstTime ?? 0));
  const result: RideDynamics = {
    movingSeconds: hasMoving ? Math.round(movingSeconds) : null,
    stoppedSeconds: hasMoving ? Math.round(stoppedSeconds) : null,
    coastingSeconds: hasWatts ? Math.round(coastingSeconds) : null,
    coastingPercent:
      hasWatts && effectiveMovingSeconds > 0
        ? Math.round((coastingSeconds / effectiveMovingSeconds) * 100)
        : null,
    climbingSeconds: hasGrade ? Math.round(climbingSeconds) : null,
    climbingPercent:
      hasGrade && effectiveMovingSeconds > 0
        ? Math.round((climbingSeconds / effectiveMovingSeconds) * 100)
        : null,
    powerHrDriftPercent,
  };
  return Object.values(result).some((value) => value != null) ? result : null;
}

export function powerZoneTimes(
  streams: CyclingStreams,
  zones: PowerZoneRange[]
): PowerZoneTime[] {
  const times = numeric(streams.time);
  const watts = numeric(streams.watts);
  const moving = booleans(streams.moving);
  if (times.length < 2 || watts.length < 2 || zones.length === 0) return [];
  const seconds = zones.map(() => 0);
  let total = 0;
  for (let index = 1; index < Math.min(times.length, watts.length); index++) {
    const duration = intervalSeconds(times, index);
    const power = watts[index];
    if (duration === 0 || power == null || moving[index] === false) continue;
    const zoneIndex = zones.findIndex(
      (zone) =>
        power >= (zone.min ?? 0) &&
        (zone.max == null || zone.max < 0 || power <= zone.max)
    );
    if (zoneIndex < 0) continue;
    seconds[zoneIndex] += duration;
    total += duration;
  }
  if (total === 0) return [];
  return zones.map((zone, index) => ({
    ...zone,
    zone: index + 1,
    seconds: Math.round(seconds[index]),
    percent: Math.round((seconds[index] / total) * 100),
  }));
}

export function distanceSplits(
  streams: CyclingStreams,
  intervalM = 5000
): RideDistanceSplit[] {
  const times = numeric(streams.time);
  const distance = numeric(streams.distance);
  const moving = booleans(streams.moving);
  const watts = numeric(streams.watts);
  const heartrate = numeric(streams.heartrate);
  const altitude = numeric(streams.altitude);
  const length = Math.min(times.length, distance.length);
  if (length < 2 || intervalM <= 0) return [];
  const finalDistance = [...distance]
    .reverse()
    .find((value): value is number => value != null);
  if (finalDistance == null || finalDistance < intervalM * 0.3) return [];

  const boundaries: number[] = [];
  for (let target = intervalM; target <= finalDistance; target += intervalM) {
    boundaries.push(target);
  }
  const lastBoundary = boundaries[boundaries.length - 1] ?? 0;
  if (finalDistance - lastBoundary >= intervalM * 0.3) {
    boundaries.push(finalDistance);
  }

  const splits: RideDistanceSplit[] = [];
  let start = 0;
  let cursor = 1;
  for (const boundary of boundaries.slice(0, 100)) {
    while (
      cursor < length - 1 &&
      (distance[cursor] == null || distance[cursor]! < boundary)
    ) {
      cursor++;
    }
    const startDistance = distance[start];
    const endDistance = distance[cursor];
    if (
      startDistance == null ||
      endDistance == null ||
      endDistance <= startDistance
    ) {
      continue;
    }
    let movingTime = 0;
    for (let index = start + 1; index <= cursor; index++) {
      if (moving[index] !== false) {
        movingTime += intervalSeconds(times, index);
      }
    }
    const elapsed =
      times[start] != null && times[cursor] != null
        ? times[cursor]! - times[start]!
        : 0;
    const timeSec = moving.some((value) => value != null)
      ? movingTime
      : elapsed;
    if (timeSec <= 0) continue;
    let elevationGain = 0;
    let elevationSamples = 0;
    for (let index = start + 1; index <= cursor; index++) {
      const before = altitude[index - 1];
      const current = altitude[index];
      if (before != null && current != null) {
        elevationGain += Math.max(0, current - before);
        elevationSamples++;
      }
    }
    const splitDistance = endDistance - startDistance;
    splits.push({
      index: splits.length + 1,
      distanceM: Math.round(splitDistance),
      timeSec: Math.round(timeSec),
      averageSpeedKmh: Math.round((splitDistance / timeSec) * 3.6 * 10) / 10,
      averageWatts: averageRange(watts, start, cursor),
      averageHeartrate: averageRange(heartrate, start, cursor),
      elevationGainM:
        elevationSamples > 0 ? Math.round(elevationGain * 10) / 10 : null,
    });
    start = cursor;
  }
  return splits;
}

function numeric(stream: TelemetryStream | undefined): (number | null)[] {
  return (stream?.data ?? []).map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  );
}

export function formatRideElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function downsample(
  times: (number | null)[],
  values: (number | null)[],
  multiplier: number
): { date: string; value: number | null }[] {
  const length = Math.min(times.length, values.length);
  const stride = Math.max(1, Math.ceil(length / 360));
  const points: { date: string; value: number | null }[] = [];
  for (let start = 0; start < length; start += stride) {
    const end = Math.min(length, start + stride);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const value = values[i];
      if (value != null) {
        sum += value * multiplier;
        count++;
      }
    }
    const time = times[Math.min(end - 1, length - 1)];
    if (time == null) continue;
    points.push({
      date: formatRideElapsed(time),
      value: count > 0 ? sum / count : null,
    });
  }
  return points;
}

// Strava's time and latlng streams share an index, so each valid coordinate can
// be tied to the same elapsed-time axis as power, cadence, speed, and heart rate.
// Bound the serialized read model: 720 points is smooth at the route card's size
// without sending a multi-hour one-second stream through a Server Component.
export function rideTimedRoutePoints(
  streams: CyclingStreams,
  maxPoints = 720
): RideTimedRoutePoint[] {
  const times = numeric(streams.time);
  const locations = streams.latlng?.data ?? [];
  const length = Math.min(times.length, locations.length);
  if (length < 2 || maxPoints < 2) return [];
  const stride = Math.max(1, Math.ceil(length / maxPoints));
  const indexes = Array.from(
    { length: Math.ceil(length / stride) },
    (_, index) => index * stride
  );
  if (indexes[indexes.length - 1] !== length - 1) indexes.push(length - 1);
  return indexes.flatMap((index): RideTimedRoutePoint[] => {
    const time = times[index];
    const location = locations[index];
    if (
      time == null ||
      time < 0 ||
      !Array.isArray(location) ||
      location.length < 2 ||
      typeof location[0] !== "number" ||
      !Number.isFinite(location[0]) ||
      location[0] < -90 ||
      location[0] > 90 ||
      typeof location[1] !== "number" ||
      !Number.isFinite(location[1]) ||
      location[1] < -180 ||
      location[1] > 180
    ) {
      return [];
    }
    return [
      {
        elapsedSec: Math.round(time),
        lat: location[0],
        lng: location[1],
      },
    ];
  });
}

export function rideTraces(streams: CyclingStreams): RideTrace[] {
  const times = numeric(streams.time);
  if (times.length === 0) return [];
  return (Object.keys(TRACE_META) as RideTraceKey[]).flatMap((key) => {
    const values = numeric(streams[key]);
    if (values.filter((value) => value != null).length < 2) return [];
    const meta = TRACE_META[key];
    return [
      {
        key,
        ...meta,
        points: downsample(times, values, key === "velocity_smooth" ? 3.6 : 1),
      },
    ];
  });
}

// The durations a power curve is taken at. Exported because the cycling OVERVIEW
// no longer parses streams to build its curve — it reads a summary precomputed at
// ingest (#2292) — and that summary's validity is keyed on this list: change it and
// every stored summary is answering the previous question. lib/cycling-stream-summary
// folds these seconds into the stored signature so the boot reconcile re-derives
// them, and re-attaches the label on the way out rather than freezing presentation
// text into a stored row.
export const POWER_CURVE_DURATIONS = [
  { seconds: 5, label: "5 sec" },
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 1200, label: "20 min" },
] as const;

export function powerCurveLabel(seconds: number): string | null {
  return (
    POWER_CURVE_DURATIONS.find((d) => d.seconds === seconds)?.label ?? null
  );
}

// Maximum rolling mean over the actual stream time axis. The provider normally
// samples each second; using timestamps (rather than array length) still prevents
// a paused/gapped stream from masquerading as a complete duration.
export function powerCurve(streams: CyclingStreams): PowerCurvePoint[] {
  const times = numeric(streams.time);
  const watts = numeric(streams.watts);
  const length = Math.min(times.length, watts.length);
  if (length < 2) return [];
  return POWER_CURVE_DURATIONS.flatMap(({ seconds, label }) => {
    let left = 0;
    let sum = 0;
    let count = 0;
    let best: number | null = null;
    for (let right = 0; right < length; right++) {
      const rightTime = times[right];
      const rightWatts = watts[right];
      if (rightTime == null) continue;
      if (rightWatts != null) {
        sum += rightWatts;
        count++;
      }
      while (
        left < right &&
        times[left] != null &&
        rightTime - (times[left] as number) > seconds
      ) {
        if (watts[left] != null) {
          sum -= watts[left] as number;
          count--;
        }
        left++;
      }
      const leftTime = times[left];
      if (
        leftTime != null &&
        rightTime - leftTime >= seconds - 1 &&
        count >= Math.max(2, seconds * 0.8)
      ) {
        best = Math.max(best ?? 0, sum / count);
      }
    }
    return best == null ? [] : [{ seconds, label, watts: Math.round(best) }];
  });
}

export function cyclingLoad(
  ftpW: number | null,
  weightedPowerW: number | null,
  durationMin: number | null
): CyclingLoad | null {
  if (
    ftpW == null ||
    ftpW <= 0 ||
    weightedPowerW == null ||
    weightedPowerW <= 0 ||
    durationMin == null ||
    durationMin <= 0
  ) {
    return null;
  }
  const intensityFactor = weightedPowerW / ftpW;
  return {
    ftpW,
    weightedPowerW,
    intensityFactor: Math.round(intensityFactor * 100) / 100,
    trainingLoad:
      Math.round((durationMin / 60) * intensityFactor ** 2 * 1000) / 10,
  };
}

function samplePoints(points: LatLng[], count: number): LatLng[] {
  if (points.length <= count) return points;
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    const [latA, lngA] = points[index - 1];
    const [latB, lngB] = points[index];
    const meanLat = ((latA + latB) / 2) * (Math.PI / 180);
    const dx = (lngB - lngA) * Math.cos(meanLat);
    const dy = latB - latA;
    cumulative.push(cumulative[index - 1] + Math.hypot(dx, dy));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return points.slice(0, count);
  let segment = 1;
  return Array.from({ length: count }, (_, index) => {
    const target = (index / (count - 1)) * total;
    while (segment < cumulative.length - 1 && cumulative[segment] < target) {
      segment++;
    }
    const before = cumulative[segment - 1];
    const after = cumulative[segment];
    const ratio = after === before ? 0 : (target - before) / (after - before);
    const [latA, lngA] = points[segment - 1];
    const [latB, lngB] = points[segment];
    return [latA + (latB - latA) * ratio, lngA + (lngB - lngA) * ratio];
  });
}

// A privacy-conscious, deterministic route identity: a coarse start/end cell plus
// a normalized shape signature. It never leaves the process or stores coordinates.
export function routeFingerprint(polyline: string | null): string | null {
  const points = decodePolyline(polyline);
  const bounds = routeBounds(points);
  if (!bounds || points.length < 3) return null;
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 1e-7);
  const spanLng = Math.max(bounds.maxLng - bounds.minLng, 1e-7);
  const cell = ([lat, lng]: LatLng) =>
    `${Math.round(lat / 0.002)},${Math.round(lng / 0.002)}`;
  const shape = samplePoints(points, 16)
    .map(([lat, lng]) => {
      const y = Math.round(((lat - bounds.minLat) / spanLat) * 12);
      const x = Math.round(((lng - bounds.minLng) / spanLng) * 12);
      return `${x.toString(13)}${y.toString(13)}`;
    })
    .join("");
  return `${cell(points[0])}|${cell(points[points.length - 1])}|${shape}`;
}
