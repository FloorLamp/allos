import type { ActivityType } from "@/lib/types";
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
  // Outdoor = not on a trainer and not a virtual sport. Temperature is recorded
  // by outdoor GPS devices only.
  const isOutdoor =
    rec.trainer !== true && !(str(sportType) ?? "").startsWith("Virtual");

  const hasHr = rec.has_heartrate === true;
  const mps = (v: unknown) => {
    const m = num(v);
    return m == null ? null : Math.round(m * 3.6 * 10) / 10; // m/s → km/h
  };

  const activity: NormActivity = {
    external_id: `${STRAVA_ID}:${id}`,
    date: p.date,
    type,
    title: str(rec.name) ?? "Activity",
    duration_min: movingSec != null ? Math.round(movingSec / 60) : null,
    distance_km:
      meters != null ? Math.round((meters / 1000) * 100) / 100 : null,
    start_time: p.hhmm,
    end_time: endHhmm,
    avg_hr: hasHr ? roundOrNull(num(rec.average_heartrate)) : null,
    max_hr: hasHr ? roundOrNull(num(rec.max_heartrate)) : null,
    elevation_m: roundOrNull(num(rec.total_elevation_gain)),
    avg_speed_kmh: mps(rec.average_speed),
    max_speed_kmh: mps(rec.max_speed),
    relative_effort: roundOrNull(num(rec.suffer_score)),
    avg_power_w: isCycling ? roundOrNull(num(rec.average_watts)) : null,
    max_power_w: isCycling ? roundOrNull(num(rec.max_watts)) : null,
    weighted_avg_power_w: isCycling
      ? roundOrNull(num(rec.weighted_average_watts))
      : null,
    avg_cadence: isCycling ? roundOrNull(num(rec.average_cadence)) : null,
    kilojoules: isCycling ? roundOrNull(num(rec.kilojoules)) : null,
    avg_temp_c: isOutdoor ? num(rec.average_temp) : null,
    workout_type: workoutTypeLabel(rec.workout_type),
  };

  // Calories → metric_samples (active_kcal), keyed on the activity's window so the
  // shared upsert dedups on re-sync. Only present on the detailed activity object.
  const samples: NormMetricSample[] = [];
  const detailRec =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>)
      : null;
  const calories = detailRec ? num(detailRec.calories) : null;
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
