import type { ActivityType } from "@/lib/types";
import { boundedOrNull, inMetricBounds } from "@/lib/ingest-bounds";
import type {
  NormActivity,
  NormBodyMetric,
  NormMetricSample,
} from "./normalize";

// Maps Oura API v2 responses (https://cloud.ouraring.com/v2/docs) into the
// provider-agnostic normalized records (see normalize.ts), so the shared upserts
// handle all of the DB mapping and idempotency. Mirrors the Strava parser: tolerant
// field reads, wall-clock helpers, and a substring-based sport classifier. This
// module is PURE (no @/lib/db, no fetch) so it lives in the unit tier
// (lib/__tests__/oura.test.ts).

export const OURA_ID = "oura";

// ---- tolerant field reads ----

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---- wall-clock helpers ----
//
// Oura datetimes are ISO 8601 WITH an explicit offset, e.g.
// "2024-05-01T23:15:30-07:00". So the literal Y-M-D-H-M fields already ARE the
// ring's local wall clock — parse them directly for the display date/HH:MM rather
// than routing through `new Date().getHours()` (which would shift on a non-UTC
// server). The full offset string is a stable, TZ-independent dedup key we store
// verbatim on the sample window.

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function localParts(dt: unknown): { date: string; hhmm: string } | null {
  const s = str(dt);
  if (!s) return null;
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return { date: `${y}-${mo}-${d}`, hhmm: `${h}:${mi}` };
}

// True instant (ms) of an offset-carrying ISO datetime, for duration arithmetic.
function instantMs(dt: unknown): number | null {
  const s = str(dt);
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// A YYYY-MM-DD `day` field, validated so a malformed value can't become a row date.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayStr(v: unknown): string | null {
  const s = str(v);
  return s && DAY_RE.test(s) ? s : null;
}

function secToMin(sec: number | null): number | null {
  return sec == null ? null : Math.round(sec / 60);
}

// ---- sleep ----
//
// A single Oura long-sleep period → nightly metric_samples (total + a
// deep/REM/light/awake stage breakdown, all in minutes, matching the Health Connect
// sleep vocab) plus average HRV, and a body_metrics row carrying the night's resting
// (lowest) heart rate. Everything is attributed to the period's `day` (Oura's wake-day
// assignment, matching how the Health Connect parser pins sleep to the wake-up day),
// and the natural key is the bedtime window, so a re-fetched night dedups.
//
// ONLY `type === "long_sleep"` (the main nightly sleep) is mapped: naps ("late_nap")
// and rest periods would double-count resting HR / HRV on the (date, source)
// body_metrics key, so they're skipped (the caller counts them). Temperature deviation
// is intentionally NOT mapped — it's a baseline-relative delta with no home in the
// current metric vocab (absolute Body Temperature vitals only).

const OURA_STAGE_METRIC: Record<string, string> = {
  deep: "sleep_deep_min",
  rem: "sleep_rem_min",
  light: "sleep_light_min",
  awake: "sleep_awake_min",
};

export function mapOuraSleep(
  s: unknown
): { samples: NormMetricSample[]; bodyMetric: NormBodyMetric | null } | null {
  if (!s || typeof s !== "object") return null;
  const rec = s as Record<string, unknown>;
  if (str(rec.type) !== "long_sleep") return null; // naps/rest are skipped

  const date = dayStr(rec.day);
  const start = str(rec.bedtime_start);
  const end = str(rec.bedtime_end);
  const totalMin = boundedOrNull(
    "sleep_min",
    secToMin(num(rec.total_sleep_duration))
  );
  // A period without a usable window, day, or total duration is unmappable.
  if (!date || !start || !end || totalMin == null) return null;

  const samples: NormMetricSample[] = [];
  const push = (metric: string, value: number | null) => {
    if (value != null)
      samples.push({ metric, date, start_time: start, end_time: end, value });
  };

  push("sleep_min", totalMin);
  const stageSecs: Record<string, unknown> = {
    deep: rec.deep_sleep_duration,
    rem: rec.rem_sleep_duration,
    light: rec.light_sleep_duration,
    awake: rec.awake_time,
  };
  for (const [stage, metric] of Object.entries(OURA_STAGE_METRIC)) {
    push(metric, boundedOrNull(metric, secToMin(num(stageSecs[stage]))));
  }
  // Nightly HRV (average RMSSD, ms) → the shared hrv_ms sample metric.
  push("hrv_ms", boundedOrNull("hrv_ms", num(rec.average_hrv)));

  // Oura's resting heart rate is the lowest HR observed during the night → the
  // shared body_metrics.resting_hr, deduped per (date, source) like every other RHR.
  const restingHr = boundedOrNull("resting_hr", num(rec.lowest_heart_rate));
  const bodyMetric: NormBodyMetric | null =
    restingHr != null
      ? // `measured_at` = the night's bedtime end, so two long-sleep periods that Oura
        // assigns to the same wake `day` collapse deterministically in the shared
        // upsert (#605) — the later night's resting HR wins.
        { date, measured_at: end, resting_hr: restingHr }
      : null;

  return { samples, bodyMetric };
}

// ---- workouts ----

// Substring hints → cardio. Everything that isn't a strength activity falls through
// to 'sport'. Oura `activity` strings are lowercase snake_case, e.g. "running",
// "strength_training", "indoor_cycling".
const CARDIO_HINTS = [
  "run",
  "jog",
  "walk",
  "hik",
  "cycl",
  "bik",
  "ride",
  "spin",
  "swim",
  "row",
  "elliptic",
  "stair",
  "ski",
  "skat",
  "kayak",
  "canoe",
  "surf",
  "cardio",
  "hiit",
  "treadmill",
  "aerobic",
];
const STRENGTH_HINTS = ["strength", "weight", "crossfit", "resistance"];

export function classifyOuraActivity(activity: unknown): ActivityType {
  const raw = (str(activity) ?? "").toLowerCase();
  if (STRENGTH_HINTS.some((h) => raw.includes(h))) return "strength";
  if (CARDIO_HINTS.some((h) => raw.includes(h))) return "cardio";
  return "sport";
}

// snake_case Oura activity → canonical sport name (prefers activities-catalog names).
const OURA_SPORT_NAMES: Record<string, string> = {
  running: "Running",
  walking: "Walking",
  hiking: "Hiking",
  cycling: "Cycling",
  indoor_cycling: "Cycling",
  mountain_biking: "Mountain Biking",
  swimming: "Swimming",
  rowing: "Rowing",
  strength_training: "Weight Training",
  weight_training: "Weight Training",
  crossfit: "CrossFit",
  yoga: "Yoga",
  pilates: "Pilates",
  hiit: "HIIT",
};

// Title-case a snake_case token: "indoor_cycling" → "Indoor Cycling". Used as the
// fallback for any activity not in OURA_SPORT_NAMES.
export function titleizeActivity(activity: string): string {
  return activity
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ouraSportName(activity: unknown): string {
  const raw = str(activity);
  if (!raw) return "Workout";
  return OURA_SPORT_NAMES[raw.toLowerCase()] ?? titleizeActivity(raw);
}

// Oura's workout `intensity` enum ("easy" | "moderate" | "hard") maps 1:1 onto the
// app's manual-entry intensity scale (lib/activity-form-model.INTENSITIES), so an
// imported workout carries the same effort label a hand-entered one would and feeds
// the calorie-estimate MET tiers. Any other/absent value → null (unknown effort).
export function ouraIntensity(v: unknown): string | null {
  const s = (str(v) ?? "").toLowerCase();
  return s === "easy" || s === "moderate" || s === "hard" ? s : null;
}

// Map a single Oura workout into a normalized activity plus any calorie sample.
// Returns null when unusable (no id/start, or a physiologically-impossible core
// distance/duration — the whole record is rejected and the caller counts it skipped,
// mirroring the Strava plausibility guard #132).
export function mapOuraWorkout(
  w: unknown
): { activity: NormActivity; samples: NormMetricSample[] } | null {
  if (!w || typeof w !== "object") return null;
  const rec = w as Record<string, unknown>;
  const id = str(rec.id);
  const startDt = str(rec.start_datetime);
  const start = localParts(startDt);
  const date = dayStr(rec.day) ?? start?.date ?? null;
  if (!id || !startDt || !start || !date) return null;

  const type = classifyOuraActivity(rec.activity);
  const endDt = str(rec.end_datetime);
  const end = localParts(endDt);
  const startMs = instantMs(startDt);
  const endMs = instantMs(endDt);
  const durationMin =
    startMs != null && endMs != null && endMs > startMs
      ? Math.round((endMs - startMs) / 60000)
      : null;
  const meters = num(rec.distance);
  const distanceKm =
    meters != null ? Math.round((meters / 1000) * 100) / 100 : null;

  // Core-field plausibility: an impossible distance/duration makes the whole workout
  // untrustworthy (#132). Optional fields (calories) are sanitized individually below.
  if (
    (distanceKm != null && !inMetricBounds("distance_km", distanceKm)) ||
    (durationMin != null && !inMetricBounds("duration_min", durationMin))
  ) {
    return null;
  }

  const sportName = ouraSportName(rec.activity);
  const activity: NormActivity = {
    external_id: `${OURA_ID}:${id}`,
    date,
    type,
    // Oura's optional freeform `label`, else the canonical sport name.
    title: str(rec.label) ?? sportName,
    duration_min: durationMin,
    distance_km: distanceKm,
    // One canonical-sport component so cardio/sport summaries group this workout
    // (e.g. under "Running") rather than fragmenting by title. Mirrors Strava.
    components: [
      {
        name: sportName,
        type,
        distance_km: distanceKm,
        duration_min: durationMin,
      },
    ],
    start_time: start.hhmm,
    end_time: end?.hhmm ?? null,
    // Oura's easy/moderate/hard effort → the app's intensity scale (see ouraIntensity).
    intensity: ouraIntensity(rec.intensity),
  };

  // Calories → active_kcal metric_sample keyed on the workout's instant window, so a
  // re-fetch dedups via the shared upsert.
  const samples: NormMetricSample[] = [];
  const calories = boundedOrNull("active_kcal", num(rec.calories));
  if (calories != null && startMs != null && endMs != null && endMs > startMs) {
    samples.push({
      metric: "active_kcal",
      date,
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      value: Math.round(calories),
    });
  }

  return { activity, samples };
}
