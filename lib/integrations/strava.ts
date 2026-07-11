import type { ActivityType } from "@/lib/types";
import { boundedOrNull, inMetricBounds } from "@/lib/ingest-bounds";
import type { NormActivity, NormMetricSample } from "./normalize";

// Maps Strava activities (https://developers.strava.com/docs/reference/) into the
// provider-agnostic normalized records (see normalize.ts), so the shared upserts
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
  VirtualRide: "Cycling",
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
  detail?: unknown
): { activity: NormActivity; samples: NormMetricSample[] } | null {
  if (!a || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  const id = num(rec.id);
  const startLocal = str(rec.start_date_local);
  const p = parts(startLocal);
  if (id == null || !startLocal || !p) return null;

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

  const hasHr = rec.has_heartrate === true;
  const mps = (v: unknown) => {
    const m = num(v);
    return m == null ? null : Math.round(m * 3.6 * 10) / 10; // m/s → km/h
  };

  const durationMin = movingSec != null ? Math.round(movingSec / 60) : null;
  const distanceKm =
    meters != null ? Math.round((meters / 1000) * 100) / 100 : null;

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
        name: stravaSportName(sportType),
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
    // store that provider-raw value unchanged, exactly like cycling RPM, rather than
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
    // re-syncs); `date` is the activity's true local day.
    const startIso = new Date(p.ms).toISOString();
    const endIso = new Date(p.ms + elapsedSec * 1000).toISOString();
    samples.push({
      metric: "active_kcal",
      date: p.date,
      start_time: startIso,
      end_time: endIso,
      value: Math.round(calories),
    });
  }

  return { activity, samples };
}

function roundOrNull(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}
