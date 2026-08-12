import {
  canonicalizeSourceClock,
  clockAtMinute,
  type ClockReading,
} from "@/lib/clock-skew";
import { hhmmToMinutes } from "@/lib/date";
import type { ActivityType } from "@/lib/types";
import { boundedOrNull, inMetricBounds } from "@/lib/ingest-bounds";
import { toKm } from "@/lib/units";
import type {
  NormActivity,
  NormMetricSample,
  NormActivityRoute,
} from "./normalize";
import {
  STRAVA_STREAM_KEYS,
  type CyclingStreams,
  type NormActivityLap,
  type NormCyclingTelemetry,
  type NormSegmentEffort,
  type TelemetryStream,
} from "./cycling-telemetry";

// Maps Strava activities (https://developers.strava.com/docs/reference/) into the
// source-agnostic normalized records (see normalize.ts), so the shared upserts
// handle all of the DB mapping and idempotency. Mirrors the structure of the
// Health Connect parser: tolerant field reads, a local-time helper, and a
// substring-based sport classifier.

export const STRAVA_ID = "strava";

// ---- wall-clock time helpers ----
//
// Strava's `start_date_local` is the activity's LOCAL wall-clock time, but it's
// formatted with a misleading trailing "Z" (e.g. an 8am ride → "...T08:00:00Z").
// So we must NOT route it through `new Date().getHours()` — on a server whose TZ
// isn't UTC that would shift the date/time by the offset. Instead parse the
// literal Y-M-D-H-M fields, and use Date.UTC only to do duration arithmetic on
// those same wall-clock numerals (read back via getUTC*). This is the opposite
// of the Health Connect parser, whose timestamps are true instants.
//
// AND `start_date_local` IS THE ONE THAT CAN BE WRONG (#2088). Strava computes it as
// `start_date + utc_offset`, and that offset is a property of the athlete's account
// as Strava understood it — stale after a move, wrong across a DST boundary, wrong
// again when a third party pushed the activity in. That is precisely how #2011's
// duplicate arrived an hour early. `start_date` is a TRUE INSTANT, so given the
// profile's own timezone the local day and clock follow with nothing inferred: the
// canonicalization primitive's branch A. We take it whenever both are available and
// fall back to the source's own wall clock otherwise, which is the pre-#2088
// behaviour exactly.

const pad = (n: number) => String(n).padStart(2, "0");

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

// `ms` is the wall-clock numerals interpreted as UTC, used purely for adding the
// elapsed time to derive an end time — not a real instant.
function parts(
  local: unknown
): { date: string; hhmm: string; ms: number } | null {
  if (typeof local !== "string") return null;
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return {
    date: `${y}-${mo}-${d}`,
    hhmm: `${h}:${mi}`,
    ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0),
  };
}

// The reported wall clock as the primitive's dated reading, and the way back — the
// two-line bridge between this parser's `{date, hhmm, ms}` shape and the one shape
// every clock question in the app is asked in.
function reportedReading(p: { date: string; hhmm: string }): ClockReading {
  return { date: p.date, minutes: hhmmToMinutes(p.hhmm) };
}
function partsOfReading(r: ClockReading): {
  date: string;
  hhmm: string;
  ms: number;
} {
  const hhmm = clockAtMinute(r.minutes);
  const [y, mo, d] = r.date.split("-").map(Number);
  return {
    date: r.date,
    hhmm,
    ms: Date.UTC(y, mo - 1, d, Math.floor(r.minutes / 60), r.minutes % 60, 0),
  };
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---- sport classification ----

// Substring hints → cardio. Everything else that isn't a strength activity falls
// through to 'sport'. Same approach as the Health Connect classifier.
const CARDIO_HINTS = [
  "run",
  "walk",
  "hik",
  "ride",
  "cycl",
  "bik",
  "swim",
  "row",
  "elliptic",
  "stair",
  "ski",
  "skat",
  "kayak",
  "canoe",
  "surf",
  "snowshoe",
  "wheelchair",
  "velomobile",
  "handcycle",
  "virtualrun",
  "virtualride",
];
const STRENGTH_HINTS = ["weighttraining", "workout", "crossfit"];

function classify(sportType: unknown, fallbackType: unknown): ActivityType {
  const raw = (str(sportType) ?? str(fallbackType) ?? "").toLowerCase();
  if (STRENGTH_HINTS.some((h) => raw.includes(h))) return "strength";
  if (CARDIO_HINTS.some((h) => raw.includes(h))) return "cardio";
  return "sport";
}

// ---- canonical sport name (for structured grouping) ----
//
// Strava rows keep the athlete's freeform `name` as the activity title (e.g. "new
// bike day") — desired. But cardio/sport summaries group by structured `components`
// (see effortEntries/getCardioByActivity), falling back to `title` only when a row
// has none; without a component every uniquely-titled ride would fragment into its
// own group. So we attach ONE component named by the canonical sport, which groups
// all rides under "Cycling" while the title stays the athlete's name.

// Split a PascalCase/camelCase Strava sport_type into Title Case words, e.g.
// "AlpineSki" → "Alpine Ski", "EBikeRide" → "E Bike Ride". Used as the fallback for
// any sport_type not in STRAVA_SPORT_NAMES below.
export function splitCamelCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

// sport_type → canonical activity name (prefers lib/activities-catalog.ts names).
const STRAVA_SPORT_NAMES: Record<string, string> = {
  Ride: "Cycling",
  GravelRide: "Cycling",
  EBikeRide: "Cycling",
  VirtualRide: "Stationary Bike",
  MountainBikeRide: "Mountain Biking",
  Run: "Running",
  VirtualRun: "Running",
  TrailRun: "Trail Run",
  Walk: "Walking",
  Hike: "Hiking",
  Swim: "Swimming",
  Rowing: "Rowing",
  WeightTraining: "Weight Training",
  Workout: "Workout",
};

// Map a Strava sport_type to a canonical sport name used for the activity's grouping
// component. Unknown types fall back to the camelCase-split of the raw type.
export function stravaSportName(sportType: unknown): string {
  const raw = str(sportType) ?? "Activity";
  return STRAVA_SPORT_NAMES[raw] ?? splitCamelCase(raw);
}

// Cycling sport types (outdoor + virtual). A trainer ride is sport_type 'Ride'
// with trainer:true, so it's covered here too. Power/cadence/kilojoules apply to
// all of these.
const CYCLING_SPORT_TYPES = new Set([
  "Ride",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "VirtualRide",
]);

// Running sport types. Strava reports run cadence in the SAME `average_cadence`
// field as cycling, so it can share the sport-agnostic avg_cadence column (#419).
const RUNNING_SPORT_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

// Strava workout_type integer codes → label. Run: 0 default, 1 race, 2 long run,
// 3 workout. Ride: 10 default, 11 race, 12 workout. Everything else → null.
function workoutTypeLabel(code: unknown): string | null {
  switch (num(code)) {
    case 1:
    case 11:
      return "race";
    case 2:
      return "long run";
    case 3:
    case 12:
      return "workout";
    default:
      return null;
  }
}

// Map a single Strava activity (a summary from the list endpoint, optionally with
// the detailed object from GET /activities/{id} for `calories`) into a normalized
// activity plus any metric samples (calories). Returns null if the record is
// unusable (no id or unparseable start).
export function mapStravaActivity(
  a: unknown,
  detail?: unknown,
  // The PROFILE's timezone. Supplied by the sync runner; omitted by callers that
  // have no profile context, which then get the source's own wall clock verbatim.
  tz?: string
): {
  activity: NormActivity;
  samples: NormMetricSample[];
  route: NormActivityRoute | null;
} | null {
  if (!a || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  const id = num(rec.id);
  const startLocal = str(rec.start_date_local);
  const reported = parts(startLocal);
  if (id == null || !startLocal || !reported) return null;

  // #2088 branch A: the true instant read in the profile's zone, when we have both.
  // The primitive returns `changed: false` for an activity whose reported clock
  // already agrees, so a re-sync of a correctly-offset ride writes the same row it
  // wrote last time.
  const instantAt = str(rec.start_date)
    ? new Date(String(rec.start_date))
    : null;
  const canonical =
    tz && instantAt
      ? canonicalizeSourceClock({
          reported: reportedReading(reported),
          instant: { at: instantAt, tz },
        })
      : null;
  const p =
    canonical?.kind === "canonical" && canonical.changed
      ? partsOfReading(canonical.reading)
      : reported;

  const sportType = rec.sport_type ?? rec.type;
  const type = classify(rec.sport_type, rec.type);
  const movingSec = num(rec.moving_time);
  const elapsedSec = num(rec.elapsed_time);
  const meters = num(rec.distance);

  // end = start + elapsed_time. p.ms holds the wall-clock numerals as UTC, so we
  // add the elapsed seconds and read the result back via getUTC* to stay in the
  // activity's local wall clock regardless of the server TZ.
  let endHhmm: string | null = null;
  if (elapsedSec != null) {
    const end = new Date(p.ms + elapsedSec * 1000);
    endHhmm = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`;
  }

  const isCycling = CYCLING_SPORT_TYPES.has(str(sportType) ?? "");
  const isRunning = RUNNING_SPORT_TYPES.has(str(sportType) ?? "");
  // Outdoor = not on a trainer and not a virtual sport. Temperature is recorded
  // by outdoor GPS devices only.
  const isOutdoor =
    rec.trainer !== true && !(str(sportType) ?? "").startsWith("Virtual");
  const activityName =
    isCycling && !isOutdoor ? "Stationary Bike" : stravaSportName(sportType);

  const hasHr = rec.has_heartrate === true;
  const mps = (v: unknown) => {
    const m = num(v);
    return m == null ? null : Math.round(m * 3.6 * 10) / 10; // m/s → km/h
  };

  const durationMin = movingSec != null ? Math.round(movingSec / 60) : null;
  // Strava reports distance in METRES. This division is the unit boundary, so the
  // result is minted canonical here (#2149) and every downstream use of `distanceKm`
  // is a `Km` — the raw metre count can no longer reach `activities.distance_km`.
  const distanceKm =
    meters != null ? toKm(Math.round((meters / 1000) * 100) / 100, "km") : null;

  // Plausibility guard (issue #132). The identity-defining distance/duration are
  // the record's core: a physiologically-impossible one makes the whole activity
  // untrustworthy, so return null → the sync counts it skipped. The optional metric
  // fields below are instead sanitized to null individually (boundedOrNull), so one
  // bad sensor field never discards an otherwise-valid ride.
  if (
    (distanceKm != null && !inMetricBounds("distance_km", distanceKm)) ||
    (durationMin != null && !inMetricBounds("duration_min", durationMin))
  ) {
    return null;
  }

  const activity: NormActivity = {
    external_id: `${STRAVA_ID}:${id}`,
    date: p.date,
    type,
    // Keep the athlete's freeform Strava name as the title (issue #15). Grouping is
    // handled by the structured component below, not the title.
    title: str(rec.name) ?? "Activity",
    duration_min: durationMin,
    distance_km: distanceKm,
    // One canonical-sport component so cardio/sport summaries group this ride under
    // e.g. "Cycling" instead of fragmenting by its unique freeform title.
    components: [
      {
        name: activityName,
        type,
        distance_km: distanceKm,
        duration_min: durationMin,
      },
    ],
    start_time: p.hhmm,
    end_time: endHhmm,
    avg_hr: hasHr
      ? boundedOrNull("heart_rate_bpm", roundOrNull(num(rec.average_heartrate)))
      : null,
    max_hr: hasHr
      ? boundedOrNull("heart_rate_bpm", roundOrNull(num(rec.max_heartrate)))
      : null,
    elevation_m: boundedOrNull(
      "elevation_m",
      roundOrNull(num(rec.total_elevation_gain))
    ),
    avg_speed_kmh: boundedOrNull("speed_kmh", mps(rec.average_speed)),
    max_speed_kmh: boundedOrNull("speed_kmh", mps(rec.max_speed)),
    relative_effort: roundOrNull(num(rec.suffer_score)),
    // Strava's MANUAL 1–10 RPE (subjective session effort) → activities.intensity,
    // the subjective effort seam (issue #1125). Distinct from relative_effort above,
    // which stays the HR-derived suffer_score — the two effort signals never cross.
    // Null perceived_exertion leaves intensity NULL (no invented rating); the shared
    // upsert's edit-lock (#133) then lets a later in-app/#1122 rating win on re-sync.
    intensity: rpeToIntensity(num(rec.perceived_exertion)),
    avg_power_w: isCycling
      ? boundedOrNull("power_w", roundOrNull(num(rec.average_watts)))
      : null,
    max_power_w: isCycling
      ? boundedOrNull("power_w", roundOrNull(num(rec.max_watts)))
      : null,
    weighted_avg_power_w: isCycling
      ? boundedOrNull("power_w", roundOrNull(num(rec.weighted_average_watts)))
      : null,
    // Cadence for cycling (crank RPM) AND running. UNIT DECISION (#419): Strava
    // reports run cadence per-leg ("half-steps", ~85–95), NOT full steps/min — we
    // store that source-raw value unchanged, exactly like cycling RPM, rather than
    // doubling it. This keeps the shared avg_cadence/"rpm" column one consistent
    // "limb cycles per minute" quantity across sports (both ≈80–100) and within the
    // cadence_rpm 0–300 envelope; a run therefore shows its per-leg cadence.
    avg_cadence:
      isCycling || isRunning
        ? boundedOrNull("cadence_rpm", roundOrNull(num(rec.average_cadence)))
        : null,
    kilojoules: isCycling
      ? boundedOrNull("kilojoules", roundOrNull(num(rec.kilojoules)))
      : null,
    avg_temp_c: isOutdoor
      ? boundedOrNull("temp_c", num(rec.average_temp))
      : null,
    workout_type: workoutTypeLabel(rec.workout_type),
  };

  // Calories → metric_samples (active_kcal), keyed on the activity's window so the
  // shared upsert dedups on re-sync. Only present on the detailed activity object.
  const samples: NormMetricSample[] = [];
  const detailRec =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>)
      : null;
  const calories = detailRec
    ? boundedOrNull("active_kcal", num(detailRec.calories))
    : null;
  if (calories != null && elapsedSec != null) {
    // Wall-clock numerals as a stable, TZ-independent dedup key (consistent across
    // re-syncs); `date` is the activity's true local day. The KEY stays on the
    // source's REPORTED numerals even when the activity's clock is canonicalized
    // (#2088): it is an identity token, not a claim about an instant, and re-keying
    // it would make one already-imported calorie row look like a new one and double
    // the day. The `date` beside it does take the canonical answer, which an
    // idempotent upsert simply corrects in place.
    const startIso = new Date(reported.ms).toISOString();
    const endIso = new Date(reported.ms + elapsedSec * 1000).toISOString();
    samples.push({
      metric: "active_kcal",
      date: p.date,
      start_time: startIso,
      end_time: endIso,
      value: Math.round(calories),
      activity_external_id: activity.external_id,
    });
  }

  // GPS route → activity_routes (issue #569). PREFER the summary polyline: it
  // respects the athlete's Strava privacy zones (endpoints near flagged addresses
  // are trimmed), a free privacy win over the full-resolution detail polyline. The
  // summary rides on both the list summary and the detail; fall back to the detail
  // polyline only if no summary is present. Capturing this costs zero extra API
  // calls (the detail is already fetched for calories).
  const summaryMap = (rec.map ?? null) as Record<string, unknown> | null;
  const detailMap = (detailRec?.map ?? null) as Record<string, unknown> | null;
  const polyline =
    str(summaryMap?.summary_polyline) ??
    str(detailMap?.summary_polyline) ??
    str(detailMap?.polyline);
  const latOf = (v: unknown): number | null =>
    Array.isArray(v) ? num(v[0]) : null;
  const lngOf = (v: unknown): number | null =>
    Array.isArray(v) ? num(v[1]) : null;
  const route: NormActivityRoute | null = polyline
    ? {
        external_id: `${STRAVA_ID}:${id}`,
        polyline,
        start_lat: latOf(rec.start_latlng),
        start_lng: lngOf(rec.start_latlng),
        end_lat: latOf(rec.end_latlng),
        end_lng: lngOf(rec.end_latlng),
      }
    : null;

  return { activity, samples, route };
}

function roundOrNull(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

// Map Strava's `perceived_exertion` — the athlete's MANUAL 1–10 RPE ("how hard it
// FELT", the subjective half of Strava's Relative Effort) — onto the app's
// manual-entry intensity scale ('easy' | 'moderate' | 'hard'), the one column an
// integration may fill in activities.intensity (issue #1125). This is a
// subjective→subjective map only: it is the same NATURE of signal a hand-entered
// session-effort rating is, so an imported ride carries the same label a self-rated
// one would. Strava's OTHER effort number, `suffer_score` (HR-derived load), stays
// on relative_effort and is DELIBERATELY never crossed into intensity — mapping an
// objective load score into the subjective column would double-count (it already
// feeds the HR-derived loading split) and launder two distinct identities into one
// (#482). Banding matches the app's own RPE anchors (INTENSITIES hints in
// lib/activity-form-model): 1–3 easy, 4–6 moderate, 7+ hard. Absent/out-of-scale
// (<= 0 / non-finite / null) → null, so an import never invents a rating.
export function rpeToIntensity(rpe: number | null | undefined): string | null {
  if (rpe == null || !Number.isFinite(rpe) || rpe <= 0) return null;
  if (rpe <= 3) return "easy";
  if (rpe <= 6) return "moderate";
  return "hard";
}

function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

// Strava's own id for a lap/segment/effort — an EXTERNAL id, not an integration
// source id (#2487 reserves `sourceId` for the latter).
function externalIdOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

function mapStreamSet(value: unknown): CyclingStreams {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const out: CyclingStreams = {};
  for (const key of STRAVA_STREAM_KEYS) {
    const stream = input[key];
    if (!stream || typeof stream !== "object") continue;
    const rec = stream as Record<string, unknown>;
    if (!Array.isArray(rec.data)) continue;
    const normalized: TelemetryStream = { data: rec.data };
    const originalSize = int(rec.original_size);
    const resolution = str(rec.resolution);
    const seriesType = str(rec.series_type);
    if (originalSize != null) normalized.original_size = originalSize;
    if (resolution) normalized.resolution = resolution;
    if (seriesType) normalized.series_type = seriesType;
    out[key] = normalized;
  }
  return out;
}

// DetailedActivity already embeds laps and segment efforts. The stream set is the
// only per-ride supplemental request. Athlete FTP/zones are snapshotted onto the
// telemetry row so later changes cannot silently rewrite the load context shown
// for an older sync.
export function mapStravaCyclingArtifacts(
  activityId: string,
  detail: unknown,
  streams: unknown,
  athlete: unknown,
  zones: unknown,
  snapshotAt: string
): {
  telemetry: NormCyclingTelemetry;
  laps: NormActivityLap[];
  segmentEfforts: NormSegmentEffort[];
} {
  const detailRec =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>)
      : {};
  const athleteRec =
    athlete && typeof athlete === "object"
      ? (athlete as Record<string, unknown>)
      : {};
  const zonesRec =
    zones && typeof zones === "object"
      ? (zones as Record<string, unknown>)
      : {};
  const zoneList = (key: "heart_rate" | "power"): unknown[] | null => {
    const block = zonesRec[key];
    if (!block || typeof block !== "object") return null;
    const list = (block as Record<string, unknown>).zones;
    return Array.isArray(list) ? list : null;
  };
  const parentExternalId = `${STRAVA_ID}:${activityId}`;
  const telemetry: NormCyclingTelemetry = {
    external_id: parentExternalId,
    streams: mapStreamSet(streams),
    ftp_w: int(athleteRec.ftp),
    heart_rate_zones: zoneList("heart_rate"),
    power_zones: zoneList("power"),
    snapshot_at: snapshotAt,
  };

  const laps = (Array.isArray(detailRec.laps) ? detailRec.laps : []).flatMap(
    (value, index): NormActivityLap[] => {
      if (!value || typeof value !== "object") return [];
      const lap = value as Record<string, unknown>;
      const externalId =
        externalIdOf(lap.id) ?? `${activityId}:lap:${index + 1}`;
      return [
        {
          external_id: parentExternalId,
          lap_external_id: externalId,
          lap_index: int(lap.lap_index) ?? index + 1,
          name: str(lap.name),
          distance_m: num(lap.distance),
          moving_time_sec: int(lap.moving_time),
          elapsed_time_sec: int(lap.elapsed_time),
          start_index: int(lap.start_index),
          end_index: int(lap.end_index),
          elevation_gain_m: num(lap.total_elevation_gain),
          average_speed_mps: num(lap.average_speed),
          max_speed_mps: num(lap.max_speed),
          average_cadence: num(lap.average_cadence),
          average_watts: num(lap.average_watts),
          average_heartrate: num(lap.average_heartrate),
          max_heartrate: num(lap.max_heartrate),
        },
      ];
    }
  );

  const segmentEfforts = (
    Array.isArray(detailRec.segment_efforts) ? detailRec.segment_efforts : []
  ).flatMap((value, index): NormSegmentEffort[] => {
    if (!value || typeof value !== "object") return [];
    const effort = value as Record<string, unknown>;
    const segment =
      effort.segment && typeof effort.segment === "object"
        ? (effort.segment as Record<string, unknown>)
        : {};
    return [
      {
        external_id: parentExternalId,
        effort_external_id:
          externalIdOf(effort.id) ?? `${activityId}:segment:${index + 1}`,
        segment_id: externalIdOf(segment.id),
        name: str(effort.name) ?? str(segment.name) ?? `Segment ${index + 1}`,
        distance_m: num(effort.distance, segment.distance),
        moving_time_sec: int(effort.moving_time),
        elapsed_time_sec: int(effort.elapsed_time),
        start_index: int(effort.start_index),
        end_index: int(effort.end_index),
        average_cadence: num(effort.average_cadence),
        average_watts: num(effort.average_watts),
        average_heartrate: num(effort.average_heartrate),
        max_heartrate: num(effort.max_heartrate),
        pr_rank: int(effort.pr_rank),
        kom_rank: int(effort.kom_rank),
      },
    ];
  });
  return { telemetry, laps, segmentEfforts };
}
