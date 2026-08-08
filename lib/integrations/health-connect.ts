import type { ActivityType } from "@/lib/types";
import { utcInstant, utcMinute, zonedDateParts } from "@/lib/date";
import { boundedOrNull, inTimeWindow } from "@/lib/ingest-bounds";
import { metricAggregation } from "@/lib/metric-buckets";
import { SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import type {
  NormActivity,
  NormHrMinute,
  NormMetricSample,
  NormVital,
  NormBodyMetric,
} from "./normalize";

// Parser for the native payload sent by the Health Connect Webhook app
// (https://github.com/mcnaveen/health-connect-webhook): one JSON object with a
// `timestamp`, `app_version`, and optional snake_case arrays per data type. We map
// it into provider-agnostic normalized records (see normalize.ts). Parsing is
// tolerant: unknown keys and malformed records are skipped and counted, and field
// names are matched defensively so a minor app version bump doesn't break ingest.

export const HEALTH_CONNECT_ID = "health-connect";

// Every top-level payload key the parser below CONSUMES. A Health Connect record
// type NOT in this set (FloorsClimbed, ElevationGained, Power, Speed, the cycling/
// running-cadence records, the menstrual-cycle family, …) has no model home yet — it
// is dropped, but its records must still be COUNTED as skipped so the Data → Review
// feed reflects that a push carried record types we discarded, rather than honestly
// reporting "N new · N changed · N unchanged" for a batch that silently vanished data
// (issue #419, the "no silent caps" rule applied to ingest). Non-array keys
// (`timestamp`, `app_version`, …) are metadata, never counted. When a new record type
// gains a home below, add its key here so it stops counting as skipped.
export const KNOWN_HEALTH_CONNECT_KEYS = new Set<string>([
  "weight",
  "body_fat",
  "resting_heart_rate",
  "steps",
  "distance",
  "active_calories",
  "total_calories",
  "hydration",
  "nutrition",
  "lean_body_mass",
  "bone_mass",
  "basal_metabolic_rate",
  "height",
  "blood_pressure",
  "blood_glucose",
  "oxygen_saturation",
  "body_temperature",
  "respiratory_rate",
  "vo2_max",
  "heart_rate_variability",
  "sleep",
  "heart_rate",
  "exercise",
  "skin_temperature",
]);

// ---- per-type granularity guidance (issue #1065) ----
//
// The Health Connect Webhook exporter lets the user pick EACH data type's granularity
// (`daily` / `full` / `1m` / `5m` / `15m`, plus off). The parser below has firm
// per-type expectations, and a wrong pick has a concrete failure mode: too fine where
// the app stores a daily total inflates the payload (the 11.3 MB wedge, #1064) and, for
// additive metrics, re-opens the cross-app origin-dedup problem server-side; too coarse
// where the app stores fine (HR at `daily`) starves the minute-bucket store. This map is
// the ONE source of truth for the recommended settings: the setup card renders it, the
// README/features table renders it, and the at-ingest detectors below read the
// recommended setting from it — a parser change can't strand the instructions.
export type ExporterSetting = "daily" | "full" | "1m" | "off";

export interface SourceFidelityRow {
  // The exporter app's data-type label(s) this row covers, verbatim-ish for the card.
  label: string;
  // The top-level payload keys this row governs. A key with a parser home is one of
  // KNOWN_HEALTH_CONNECT_KEYS (the registry-completeness test binds the two). No row
  // currently recommends `off`; the setting stays available for a future record type
  // that the exporter offers before the parser has a home for it, so the card can
  // still tell the user to leave it disabled rather than silently omitting it.
  keys: string[];
  // The exporter option to select for this row.
  setting: ExporterSetting;
  // Why — what the app stores, in one clause for the card's "Why" column.
  why: string;
}

export const SOURCE_FIDELITY: SourceFidelityRow[] = [
  {
    label: "Steps, Distance, Active/Total calories",
    keys: ["steps", "distance", "active_calories", "total_calories"],
    setting: "daily",
    why: "stored as daily totals; daily also lets Health Connect apply its own cross-app origin dedup, so the number matches the phone's Health Connect screen",
  },
  {
    label: "Heart rate",
    keys: ["heart_rate"],
    setting: "1m",
    why: "stored as minute buckets (min/max per minute); full/per-second is discarded ~60:1 and 5m/15m/daily starves the minute store that feeds HR charts",
  },
  {
    label: "Weight, Body fat, Resting HR, Height, Lean/Bone mass, BMR",
    keys: [
      "weight",
      "body_fat",
      "resting_heart_rate",
      "height",
      "lean_body_mass",
      "bone_mass",
      "basal_metabolic_rate",
    ],
    setting: "daily",
    why: "folded to a per-day aggregate in Body Metrics",
  },
  {
    label:
      "Blood pressure, Glucose, SpO₂, Temperature, Respiratory rate, VO₂max, HRV",
    keys: [
      "blood_pressure",
      "blood_glucose",
      "oxygen_saturation",
      "body_temperature",
      "respiratory_rate",
      "vo2_max",
      "heart_rate_variability",
    ],
    setting: "full",
    why: "every individual reading is kept (vitals / HRV samples)",
  },
  {
    label: "Sleep",
    keys: ["sleep"],
    setting: "full",
    why: "per-session + stages, attributed to the wake-up day",
  },
  {
    label: "Exercise",
    keys: ["exercise"],
    setting: "full",
    why: "per-session → workouts in Training history",
  },
  {
    label: "Hydration, Nutrition",
    keys: ["hydration", "nutrition"],
    setting: "daily",
    why: "daily flows (nutrition rides on a food tracker's Health Connect sync)",
  },
  {
    label: "Skin temperature",
    keys: ["skin_temperature"],
    setting: "full",
    why: "one nightly variation reading (a signed delta from your tracker's own baseline), kept per night alongside HRV and sleep",
  },
];

// The recommended exporter setting for a payload key, from SOURCE_FIDELITY. Undefined
// for a key not in the map. Used by the at-ingest detectors so the hint text and the
// setup card can never disagree about what to recommend (one source of truth).
export function recommendedSettingForKey(
  key: string
): ExporterSetting | undefined {
  return SOURCE_FIDELITY.find((row) => row.keys.includes(key))?.setting;
}

// ---- at-ingest wrong-setting detection (issue #1065) ----
//
// The payload's SHAPE reveals the granularity the user picked, so the server can
// diagnose a wrong setting instead of degrading silently. Detection is INFORMATIONAL —
// it never gates or drops a record; it appends a hint to the sync event's warnings,
// surfaced in Data → Review next to the insert/skip split.

// Summable interval metrics that Health Connect stores as DAILY totals. Arriving as
// many sub-daily intervals per day means the exporter is set finer than `daily` — the
// payload-inflation case. Kept as an explicit list (a subset of the SOURCE_FIDELITY
// `daily` rows): point/day metrics like weight are naturally ~1/day and can't inflate,
// so only the genuinely-additive interval types are checked.
const FINE_GRAINED_CHECK: { key: string; label: string }[] = [
  { key: "steps", label: "Steps" },
  { key: "distance", label: "Distance" },
  { key: "active_calories", label: "Active calories" },
  { key: "total_calories", label: "Total calories" },
];

// A `daily` interval metric yields ~1 record/day/origin (a handful even with several
// origin apps). 8+ records in a single day is unmistakably a sub-daily (`15m`/`1m`)
// setting — well clear of any legitimate per-origin daily count.
export const FINE_GRAINED_ROWS_PER_DAY = 8;

// The count signal above reads ONE PUSH, but a real exporter pushes INCREMENTALLY:
// it sends only the buckets that changed since the last push, so a phone syncing every
// few minutes at a `15m` setting delivers 1–2 fresh rows per push forever and never
// reaches 8 — while the DAY quietly accumulates ~96 of them (the Fitbit-exporter payload audit). The count
// threshold silently assumed each push carries a whole day.
//
// So the shape of a SINGLE record is the second, push-size-independent signal: a
// `daily` record's window spans midnight→now, whereas a `15m`/`1m` bucket is minutes
// wide. A daily-stored additive metric arriving in windows an hour or narrower is
// therefore a fine-grained setting regardless of how few rows the push carried.
export const SUB_DAILY_WINDOW_MAX_MIN = 60;
// Require two such records before hinting: a genuine `daily` push made within an hour
// of local midnight is itself a short window, and one origin doing that shouldn't trip
// the hint. Two independent short windows in one batch is the fine-grained shape. (The
// hint is informational — it never drops or gates a record — so an occasional
// false negative here costs nothing.)
export const SUB_DAILY_MIN_ROWS = 2;

// Heart rate at `1m` yields ~1440 records/day; `daily` yields ~1/day. To avoid
// mistaking a sparse-but-fine day for a daily aggregate, only flag it when the batch
// spans ≥2 distinct days with ≤2 records on the busiest day (the daily-aggregate shape).
export const COARSE_HR_MIN_DAYS = 2;
export const COARSE_HR_MAX_ROWS_PER_DAY = 2;

function looseArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];
}

// The calendar-day key (UTC date prefix) of a record's primary instant, or null when
// none is present/valid. A coarse heuristic — the exact profile-timezone day isn't
// needed to tell 1/day from 1440/day. Reads `time` (point records) then `start_time`
// (interval records).
function recordDayKey(rec: Record<string, unknown>): string | null {
  const iso =
    (typeof rec.time === "string" && rec.time) ||
    (typeof rec.start_time === "string" && rec.start_time) ||
    null;
  if (!iso) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// The most records any single calendar day carries, over the given records. Pure.
export function maxRecordsPerDay(recs: Record<string, unknown>[]): number {
  const perDay = new Map<string, number>();
  for (const rec of recs) {
    const day = recordDayKey(rec);
    if (!day) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  let max = 0;
  for (const n of perDay.values()) if (n > max) max = n;
  return max;
}

// How many of the given interval records span a window of `maxMinutes` or less — the
// push-size-independent fine-grained signal (see SUB_DAILY_WINDOW_MAX_MIN). A record
// missing either endpoint, or carrying a non-positive/unparseable window, is not
// counted: absent evidence is never evidence of a wrong setting. Pure.
export function shortWindowRecords(
  recs: Record<string, unknown>[],
  maxMinutes: number
): number {
  let n = 0;
  for (const rec of recs) {
    const start = typeof rec.start_time === "string" ? rec.start_time : null;
    const end = typeof rec.end_time === "string" ? rec.end_time : null;
    if (!start || !end) continue;
    const mins = minutesBetween(start, end);
    if (mins != null && mins <= maxMinutes) n++;
  }
  return n;
}

// The number of distinct calendar days the given records span. Pure.
export function distinctRecordDays(recs: Record<string, unknown>[]): number {
  const days = new Set<string>();
  for (const rec of recs) {
    const day = recordDayKey(rec);
    if (day) days.add(day);
  }
  return days.size;
}

// Detect a mis-set exporter granularity from the payload shape and return actionable
// hint lines for the sync event (issue #1065). Pure and defensive: a non-object body,
// or a type absent from the batch, contributes nothing. The recommended setting in
// each hint comes from SOURCE_FIDELITY (recommendedSettingForKey), never a literal.
export function detectGranularityHints(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const payload = body as Record<string, unknown>;
  const hints: string[] = [];

  // Too fine: a daily-stored additive metric arriving either as many sub-daily rows
  // per day (a whole-day push) or as several narrow windows (an incremental push that
  // never accumulates enough rows to trip the count — see SUB_DAILY_WINDOW_MAX_MIN).
  // Either signal alone is enough; they emit ONE hint per metric, not one per signal.
  for (const { key, label } of FINE_GRAINED_CHECK) {
    const recs = looseArray(payload[key]);
    if (!recs.length) continue;
    const manyPerDay = maxRecordsPerDay(recs) >= FINE_GRAINED_ROWS_PER_DAY;
    const narrowWindows =
      shortWindowRecords(recs, SUB_DAILY_WINDOW_MAX_MIN) >= SUB_DAILY_MIN_ROWS;
    if (manyPerDay || narrowWindows) {
      const setting = recommendedSettingForKey(key) ?? "daily";
      hints.push(
        `${label} look like a fine-grained setting — set ${label} to \`${setting}\` in the webhook app (large payloads risk rejection).`
      );
    }
  }

  // Too coarse: heart rate arriving as daily aggregates (≈1 record/day over ≥2 days),
  // which starves the minute-bucket store the HR charts read.
  const hr = looseArray(payload.heart_rate);
  if (
    hr.length &&
    distinctRecordDays(hr) >= COARSE_HR_MIN_DAYS &&
    maxRecordsPerDay(hr) <= COARSE_HR_MAX_ROWS_PER_DAY
  ) {
    const setting = recommendedSettingForKey("heart_rate") ?? "1m";
    hints.push(
      `Heart rate looks like a daily setting — set Heart rate to \`${setting}\` to get minute-level charts.`
    );
  }

  return hints;
}

// Count the records carried under top-level array keys the parser does NOT consume.
// Pure and defensive: a non-object body, a non-array value, or a known key all
// contribute 0. This is the "unknown record type" tally that folds into out.skipped
// so dropped types are visible in the Review feed (issue #419).
export function countUnknownRecords(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  let total = 0;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (KNOWN_HEALTH_CONNECT_KEYS.has(key)) continue;
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

export interface ParsedPayload {
  bodyMetrics: NormBodyMetric[];
  samples: NormMetricSample[];
  hrMinutes: NormHrMinute[];
  activities: NormActivity[];
  vitals: NormVital[];
  skipped: number;
  details: HealthConnectSyncDetails;
}

export interface HealthConnectOriginChoice {
  date: string;
  metric: string;
  chosen: string;
  ignored: string[];
}

export interface HealthConnectSyncDetails {
  warnings: string[];
  origins: HealthConnectOriginChoice[];
}

// ---- local time helpers (day/minute attribution in the PROFILE's IANA timezone) ----
// The exporter sends absolute timestamps (with a Z/offset); the ingest route resolves
// the pushing profile from its token and passes that profile's timezone (the same
// resolution as today(profileId)), so we attribute each instant to a calendar day
// and minute in the PROFILE's zone, NOT the process TZ — an evening event lands on
// the right local day even though production Docker runs UTC, and steps/calories/
// sleep bucket to the same day as activities/doses/digests (issue #94). `date` feeds
// metric_samples.date. `minute` is the hr_minutes.ts bucket key, which since #2205 is
// the sample's own UTC minute and takes no timezone at all — only `date` still does.

function parts(
  iso: unknown,
  tz: string
): { date: string; minute: string; hhmm: string } | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Reject a year-3000 / pre-1900 instant (issue #132): parsing succeeds but the
  // day attribution would silently skew Trends windows, recaps, and insights. A
  // null return folds into the caller's existing skip-and-count path.
  if (!inTimeWindow(d.getTime())) return null;
  const { date, hhmm } = zonedDateParts(tz, d);
  return { date, minute: utcMinute(d), hhmm };
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];
}

// The webhook exporter preserves the Android package that originally wrote a
// Health Connect record under metadata.data_origin. Keep it separate from the
// integration source so Fitbit-via-HC and Garmin-via-HC can coexist (#1102).
function dataOrigin(rec: Record<string, unknown>): string | null {
  const metadata = rec.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).data_origin;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function originChoices(
  samples: NormMetricSample[]
): HealthConnectOriginChoice[] {
  const groups = new Map<string, Map<string, number>>();
  for (const sample of samples) {
    if (metricAggregation(sample.metric) !== "SUM" || !sample.origin) continue;
    const key = `${sample.date}\0${sample.metric}`;
    let byOrigin = groups.get(key);
    if (!byOrigin) {
      byOrigin = new Map();
      groups.set(key, byOrigin);
    }
    byOrigin.set(
      sample.origin,
      (byOrigin.get(sample.origin) ?? 0) + sample.value
    );
  }
  const out: HealthConnectOriginChoice[] = [];
  for (const [key, byOrigin] of groups) {
    if (byOrigin.size < 2) continue;
    const [date, metric] = key.split("\0");
    const ordered = [...byOrigin.entries()].sort(
      ([aOrigin, aValue], [bOrigin, bValue]) =>
        bValue - aValue || aOrigin.localeCompare(bOrigin)
    );
    out.push({
      date,
      metric,
      chosen: ordered[0][0],
      ignored: ordered.slice(1).map(([origin]) => origin),
    });
  }
  return out.sort(
    (a, b) => b.date.localeCompare(a.date) || a.metric.localeCompare(b.metric)
  );
}

// ---- exercise type → (activity type, title) ----

const CARDIO_HINTS = [
  "run",
  "walk",
  "hik",
  "cycl",
  "bik",
  "swim",
  "row",
  "elliptic",
  "stair",
  "treadmill",
  "jog",
  "ski",
  "skat",
  "cardio",
  "spin",
];

// AndroidX ExerciseSessionRecord.EXERCISE_TYPE_* constants → the library's OWN
// snake_case string name for that constant (its EXERCISE_TYPE_STRING_TO_INT_MAP
// keys). Real exporter builds send `type` as the raw enum int's toString() — the
// SAME convention `classifyStage` below already handles for sleep stages — so a
// Fitbit-sourced "other workout" session arrives as `"0"` and, without this table,
// title-cases into an activity literally named "0" (the Fitbit-exporter payload audit).
//
// Mapping to the AndroidX NAME rather than straight to a title means the numeric and
// string spellings converge on ONE code path: the name flows through the same
// title-casing and CARDIO_HINTS matching below, so `56` and `"running"` classify
// identically and a hint added for one spelling covers both. Note `0` → "workout",
// which is the UNSPECIFIED sentinel (see UNSPECIFIED_EXERCISE_LABEL below): the title
// still reads "Workout", but the activity type is `unclassified`, not `sport` (#2272).
//
// The gaps in the sequence (1, 3, 6, 7, …) are reserved/removed values in the
// upstream enum, not omissions here. A numeric type ABSENT from this table (a newer
// library constant) falls back to the generic default rather than a bare digit.
const EXERCISE_TYPE_NAMES: Record<string, string> = {
  "0": "workout", // EXERCISE_TYPE_OTHER_WORKOUT
  "2": "badminton",
  "4": "baseball",
  "5": "basketball",
  "8": "biking",
  "9": "biking_stationary",
  "10": "boot_camp",
  "11": "boxing",
  "13": "calisthenics",
  "14": "cricket",
  "16": "dancing",
  "25": "elliptical",
  "26": "exercise_class",
  "27": "fencing",
  "28": "football_american",
  "29": "football_australian",
  "31": "frisbee_disc",
  "32": "golf",
  "33": "guided_breathing",
  "34": "gymnastics",
  "35": "handball",
  "36": "high_intensity_interval_training",
  "37": "hiking",
  "38": "ice_hockey",
  "39": "ice_skating",
  "44": "martial_arts",
  "46": "paddling",
  "47": "paragliding",
  "48": "pilates",
  "50": "racquetball",
  "51": "rock_climbing",
  "52": "roller_hockey",
  "53": "rowing",
  "54": "rowing_machine",
  "55": "rugby",
  "56": "running",
  "57": "running_treadmill",
  "58": "sailing",
  "59": "scuba_diving",
  "60": "skating",
  "61": "skiing",
  "62": "snowboarding",
  "63": "snowshoeing",
  "64": "soccer",
  "65": "softball",
  "66": "squash",
  "68": "stair_climbing",
  "69": "stair_climbing_machine",
  "70": "strength_training",
  "71": "stretching",
  "72": "surfing",
  "73": "swimming_open_water",
  "74": "swimming_pool",
  "75": "table_tennis",
  "76": "tennis",
  "78": "volleyball",
  "79": "walking",
  "80": "water_polo",
  "81": "weightlifting",
  "82": "wheelchair",
  "83": "yoga",
};

// The label a session gets when the source named no exercise type at all. AndroidX's
// EXERCISE_TYPE_OTHER_WORKOUT ("0") maps to the snake_case "workout" above, and a
// missing or unrecognized value lands here too — all three mean the same thing: a
// workout, unspecified.
const UNSPECIFIED_EXERCISE_LABEL = "workout";

// Resolve a raw `type` to the label the classifier works from: an all-digits value is
// looked up as an AndroidX constant (unknown numbers → the generic default, never a
// bare digit as a title); anything else passes through as the string it already is.
function exerciseTypeLabel(rawType: unknown): string {
  const raw = typeof rawType === "string" ? rawType.trim() : "";
  if (!raw) return UNSPECIFIED_EXERCISE_LABEL;
  if (/^\d+$/.test(raw))
    return EXERCISE_TYPE_NAMES[raw] ?? UNSPECIFIED_EXERCISE_LABEL;
  return raw;
}

// A STATED ABSENCE, not a category (#2272). Health Connect's own vocabulary has a way
// to say "a workout, unspecified" — EXERCISE_TYPE_OTHER_WORKOUT — and Fitbit's
// exporter uses it for exactly the sessions Fitbit itself never categorized. A missing
// or unrecognized `type` says the same thing from the other direction.
function declinedToClassify(label: string): boolean {
  return label.trim().toLowerCase() === UNSPECIFIED_EXERCISE_LABEL;
}

// Classify one exercise session into an activity type + a display title.
//
// The `sport` else-branch used to be the WHOLE defect (#2272): Health Connect sent
// "a workout, unspecified", CARDIO_HINTS found no hit, and the row came out asserting
// `sport` — a classification no source ever made. `sport` was doing double duty as a
// real category AND as the we-don't-know placeholder, so nothing downstream (the
// user, a tally, a weekly target, the duplicate detector) could tell an asserted type
// from a guessed one. Now the parser can say the true thing instead.
//
// The absence of a STRENGTH branch here is a separate, secondary defect the issue
// names and deliberately leaves: when the source DID state strength_training, the
// mapping is wrong rather than invented, and that is its own fix.
function classifyExercise(rawType: unknown): {
  type: ActivityType;
  title: string;
} {
  const raw = exerciseTypeLabel(rawType);
  const norm = raw.toLowerCase();
  const title = raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const type: ActivityType = declinedToClassify(raw)
    ? "unclassified"
    : CARDIO_HINTS.some((h) => norm.includes(h))
      ? "cardio"
      : "sport";
  return { type, title };
}

// Classify a sleep stage into one of the four charted buckets, or null (unknown /
// generic "sleeping" / out-of-session). The exporter sends `stage` as the AndroidX
// enum's toString(), whose exact spelling isn't documented — so match defensively
// on numeric constants and keyword substrings, like classifyExercise above.
type SleepStage = "deep" | "rem" | "light" | "awake";
function classifyStage(raw: unknown): SleepStage | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  // AndroidX SleepSessionRecord stage-type constants, in case the value is numeric.
  const NUMERIC: Record<string, SleepStage | null> = {
    "0": null, // unknown
    "1": "awake",
    "2": null, // sleeping (generic) — counted in total, not in the breakdown
    "3": "awake", // out_of_bed
    "4": "light",
    "5": "deep",
    "6": "rem",
    "7": "awake", // awake_in_bed
  };
  if (s in NUMERIC) return NUMERIC[s];
  if (s.includes("deep")) return "deep";
  if (s.includes("rem")) return "rem";
  if (s.includes("light")) return "light";
  if (s.includes("awake") || s.includes("out_of_bed")) return "awake";
  return null;
}

function minutesBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round((b - a) / 60000);
}

// The same window in EXACT seconds. Sleep durations derive from this rather than from
// minutesBetween(...) * 60: that round-trip quantizes to whole minutes first, which
// would re-introduce the per-stage inflation (the Fitbit-exporter payload audit) for any exporter build that omits
// `duration_seconds` and leaves the window as the only source. Activity `duration_min`
// keeps using minutesBetween — it IS a whole-minute field.
function secondsBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return (b - a) / 1000;
}

export function parseHealthConnectPayload(
  body: unknown,
  tz: string
): ParsedPayload {
  const out: ParsedPayload = {
    bodyMetrics: [],
    samples: [],
    hrMinutes: [],
    activities: [],
    vitals: [],
    skipped: 0,
    details: { warnings: [], origins: [] },
  };
  if (!body || typeof body !== "object") {
    return out;
  }
  const payload = body as Record<string, unknown>;

  // Records of a type the parser has no home for are dropped but COUNTED (issue #419)
  // so the Review feed's received/skipped tally reflects them instead of silently
  // vanishing them (mirrors the plausibility skip path #132).
  out.skipped += countUnknownRecords(payload);

  // --- weight / body fat % / resting HR → one body_metrics row per local day ---
  // All three share the body_metrics home: weight is last-wins per day;
  // body fat and resting HR are day-averaged (they were point metrics, averaged per
  // day back when they lived in metric_samples). A day may carry any subset — a
  // weightless row (HR/body-fat only) is valid now that body_metrics.weight_kg is
  // nullable, so nothing has to be diverted to metric_samples to avoid loss.
  interface DayAgg {
    weight_kg: number | null;
    bfSum: number;
    bfN: number;
    rhrSum: number;
    rhrN: number;
  }
  const byDate = new Map<string, DayAgg>();
  const dayFor = (date: string): DayAgg => {
    let a = byDate.get(date);
    if (!a) {
      a = { weight_kg: null, bfSum: 0, bfN: 0, rhrSum: 0, rhrN: 0 };
      byDate.set(date, a);
    }
    return a;
  };
  // Track the earliest body-metric instant in this batch (#606). The exporter re-sends
  // a rolling 48h window, so the OLDEST day in a MULTI-day push is only partially
  // covered: its body-fat / resting-HR "day average" is computed from a partial tail
  // and would otherwise overwrite the fuller value stored when the day was wholly in
  // the window. The day containing the earliest instant is the (only) partial one —
  // every later day is fully spanned by [earliest, now]. We flag it ONLY when ≥2
  // distinct body-metric days are present: with a single day we can't tell the trailing
  // old edge from an in-progress "today" (freezing today's average at its first-seen
  // value would be its own bug), so we leave the normal last-wins merge in place. The
  // flag holds only the AVERAGED fields on the upsert; weight is last-of-day, unaffected.
  let earliestBodyMs: number | null = null;
  const noteInstant = (iso: unknown) => {
    if (typeof iso !== "string") return;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t) || !inTimeWindow(t)) return;
    if (earliestBodyMs === null || t < earliestBodyMs) earliestBodyMs = t;
  };
  for (const w of asArray(payload.weight)) {
    const p = parts(w.time, tz);
    const kg = boundedOrNull("weight_kg", num(w.kilograms, w.kg, w.weight));
    if (!p || kg == null) {
      out.skipped++;
      continue;
    }
    noteInstant(w.time);
    dayFor(p.date).weight_kg = kg; // last reading of the day wins
  }
  for (const b of asArray(payload.body_fat)) {
    const p = parts(b.time, tz);
    const pct = boundedOrNull(
      "body_fat_pct",
      num(b.percentage, b.percent, b.value)
    );
    if (!p || pct == null) {
      out.skipped++;
      continue;
    }
    noteInstant(b.time);
    const a = dayFor(p.date);
    a.bfSum += pct;
    a.bfN++;
  }
  for (const r of asArray(payload.resting_heart_rate)) {
    const p = parts(r.time, tz);
    const bpm = boundedOrNull(
      "resting_hr",
      num(r.bpm, r.beatsPerMinute, r.value)
    );
    if (!p || bpm == null) {
      out.skipped++;
      continue;
    }
    noteInstant(r.time);
    const a = dayFor(p.date);
    a.rhrSum += bpm;
    a.rhrN++;
  }
  // Only the oldest day of a MULTI-day window is treated as partial (see above).
  const partialDate =
    earliestBodyMs !== null && byDate.size >= 2
      ? zonedDateParts(tz, new Date(earliestBodyMs)).date
      : null;
  out.bodyMetrics = [...byDate.entries()].map(([date, a]) => ({
    date,
    ...(partialDate !== null && date === partialDate
      ? { partial_day: true }
      : {}),
    ...(a.weight_kg != null ? { weight_kg: a.weight_kg } : {}),
    ...(a.bfN ? { body_fat_pct: Math.round((a.bfSum / a.bfN) * 10) / 10 } : {}),
    ...(a.rhrN ? { resting_hr: Math.round(a.rhrSum / a.rhrN) } : {}),
  }));

  // --- summable / scalar daily metrics → metric_samples ---
  const interval = (
    key: string,
    metric: string,
    valueOf: (rec: Record<string, unknown>) => number | null
  ) => {
    for (const rec of asArray(payload[key])) {
      const start =
        typeof rec.start_time === "string" ? rec.start_time : undefined;
      const end = typeof rec.end_time === "string" ? rec.end_time : start;
      const p = parts(start, tz);
      // Bound the canonical value against the metric's plausibility envelope; an
      // out-of-range reading folds into the same skip path as a missing one (#132).
      const value = boundedOrNull(metric, valueOf(rec));
      if (!p || !start || !end || value == null) {
        out.skipped++;
        continue;
      }
      out.samples.push({
        metric,
        date: p.date,
        start_time: start,
        end_time: end,
        value,
        origin: dataOrigin(rec),
        activity_external_id: null,
      });
    }
  };
  interval("steps", "steps", (r) => num(r.count, r.steps, r.value));
  interval("distance", "distance_km", (r) => {
    const m = num(r.meters, r.distance_meters, r.value);
    return m == null ? null : m / 1000;
  });
  interval("active_calories", "active_kcal", (r) =>
    num(r.calories, r.kcal, r.value)
  );
  interval("total_calories", "total_kcal", (r) =>
    num(r.calories, r.kcal, r.value)
  );

  // Hydration (L/day) — interval.
  interval("hydration", "hydration_l", (r) => num(r.liters, r.litres, r.value));

  // Nutrition — one record carries several nutrients; emit a sample per nutrient
  // that's present (a single pass, so absent optional fields don't count as skips).
  const NUTRIENTS: [string, string][] = [
    ["calories", "nutrition_kcal"],
    ["protein_grams", "protein_g"],
    ["carbs_grams", "carbs_g"],
    ["fat_grams", "fat_g"],
    ["sugar_grams", "sugar_g"],
    ["sodium_grams", "sodium_g"],
    ["dietary_fiber_grams", "fiber_g"],
  ];
  for (const rec of asArray(payload.nutrition)) {
    const start =
      typeof rec.start_time === "string" ? rec.start_time : undefined;
    const end = typeof rec.end_time === "string" ? rec.end_time : start;
    const p = parts(start, tz);
    if (!p || !start || !end) {
      out.skipped++;
      continue;
    }
    for (const [field, metric] of NUTRIENTS) {
      const value = boundedOrNull(metric, num(rec[field]));
      if (value == null) continue; // absent/out-of-bounds nutrient — not counted
      out.samples.push({
        metric,
        date: p.date,
        start_time: start,
        end_time: end,
        value,
        origin: dataOrigin(rec),
      });
    }
  }

  // Point measurements (start == end == measurement time) → metric_samples.
  const point = (
    key: string,
    metric: string,
    valueOf: (rec: Record<string, unknown>) => number | null
  ) => {
    for (const rec of asArray(payload[key])) {
      const t = typeof rec.time === "string" ? rec.time : undefined;
      const p = parts(t, tz);
      const value = boundedOrNull(metric, valueOf(rec));
      if (!p || !t || value == null) {
        out.skipped++;
        continue;
      }
      out.samples.push({
        metric,
        date: p.date,
        start_time: t,
        end_time: t,
        value,
        origin: dataOrigin(rec),
      });
    }
  };
  // Body composition.
  point("lean_body_mass", "lean_mass_kg", (r) =>
    num(r.kilograms, r.kg, r.value)
  );
  point("bone_mass", "bone_mass_kg", (r) => num(r.kilograms, r.kg, r.value));
  point("basal_metabolic_rate", "bmr_kcal", (r) => {
    const w = num(r.watts, r.value); // watts → kcal/day
    return w == null ? null : Math.round((w * 86400) / 4184);
  });
  point("height", "height_cm", (r) => {
    const m = num(r.meters, r.value);
    return m == null ? null : Math.round(m * 100);
  });
  // (Skin temperature is emitted AFTER the sleep block below — it is a per-NIGHT
  // reading and has to borrow the session's wake-day attribution.)

  // --- vitals & biomarkers → medical_records (reference-range flagged) ---
  const vital = (
    key: string,
    canonical: string,
    category: "vitals" | "lab" | "biomarker",
    unit: string,
    valueOf: (rec: Record<string, unknown>) => number | null
  ) => {
    for (const rec of asArray(payload[key])) {
      const t = typeof rec.time === "string" ? rec.time : undefined;
      const p = parts(t, tz);
      const value = boundedOrNull(canonical, valueOf(rec));
      if (!p || !t || value == null) {
        out.skipped++;
        continue;
      }
      out.vitals.push({
        external_id: `${HEALTH_CONNECT_ID}:${canonical}:${t}`,
        date: p.date,
        // The reading's own instant (#2154) — the same moment the external_id
        // already encodes, normalized to the canonical shape. external_id stays
        // the dedupe key, verbatim and unchanged.
        occurred_at: utcInstant(new Date(t)),
        category,
        name: canonical,
        canonical,
        value_num: value,
        unit,
      });
    }
  };
  // Blood pressure is two analytes per reading (same timestamp, distinct canonicals).
  for (const rec of asArray(payload.blood_pressure)) {
    const t = typeof rec.time === "string" ? rec.time : undefined;
    const p = parts(t, tz);
    const sys = boundedOrNull(
      "Blood Pressure Systolic",
      num(rec.systolic, rec.systolic_mmhg)
    );
    const dia = boundedOrNull(
      "Blood Pressure Diastolic",
      num(rec.diastolic, rec.diastolic_mmhg)
    );
    if (!p || !t || (sys == null && dia == null)) {
      out.skipped++;
      continue;
    }
    if (sys != null)
      out.vitals.push({
        external_id: `${HEALTH_CONNECT_ID}:Blood Pressure Systolic:${t}`,
        date: p.date,
        occurred_at: utcInstant(new Date(t)),
        category: "vitals",
        name: "Blood Pressure Systolic",
        canonical: "Blood Pressure Systolic",
        value_num: sys,
        unit: "mmHg",
      });
    if (dia != null)
      out.vitals.push({
        external_id: `${HEALTH_CONNECT_ID}:Blood Pressure Diastolic:${t}`,
        date: p.date,
        occurred_at: utcInstant(new Date(t)),
        category: "vitals",
        name: "Blood Pressure Diastolic",
        canonical: "Blood Pressure Diastolic",
        value_num: dia,
        unit: "mmHg",
      });
  }
  // Glucose mmol/L → mg/dL; body temperature °C → °F (canonical units).
  // Glucose is a lab (#1076), not a vital sign — category 'lab' so it stays on the
  // lab list once the biomarker surfaces scope to `lab` only.
  vital("blood_glucose", "Glucose", "lab", "mg/dL", (r) => {
    const v = num(r.mmol_per_liter, r.mmol, r.value);
    return v == null ? null : Math.round(v * 18.0156 * 10) / 10;
  });
  vital("oxygen_saturation", "Oxygen Saturation", "vitals", "%", (r) =>
    num(r.percentage, r.percent, r.value)
  );
  vital("body_temperature", "Body Temperature", "vitals", "degF", (r) => {
    const c = num(r.celsius, r.value);
    return c == null ? null : Math.round(((c * 9) / 5 + 32) * 10) / 10;
  });
  vital("respiratory_rate", "Respiratory Rate", "vitals", "breaths/min", (r) =>
    num(r.rate, r.value)
  );
  vital("vo2_max", "VO2 Max", "biomarker", "mL/kg/min", (r) =>
    num(r.ml_per_kg_per_min, r.value)
  );

  // HRV: a point measurement → metric_samples (start == end == time).
  const hrvRecords = asArray(payload.heart_rate_variability);
  const hrvBefore = out.samples.length;
  for (const h of hrvRecords) {
    const t = typeof h.time === "string" ? h.time : undefined;
    const p = parts(t, tz);
    const ms = boundedOrNull(
      "hrv_ms",
      num(h.rmssd_millis, h.milliseconds, h.ms, h.rmssd, h.value)
    );
    if (!p || !t || ms == null) {
      out.skipped++;
      continue;
    }
    out.samples.push({
      metric: "hrv_ms",
      date: p.date,
      start_time: t,
      end_time: t,
      value: ms,
      origin: dataOrigin(h),
    });
  }
  if (hrvRecords.length > 0 && out.samples.length === hrvBefore) {
    out.details.warnings.push(
      "heart_rate_variability records were all skipped — exporter shape not recognized"
    );
  }

  // Sleep: total duration (minutes) per session → metric_samples 'sleep_min', plus a
  // per-stage breakdown → 'sleep_deep_min' / '_rem_' / '_light_' / '_awake_'. A
  // session spans midnight, so everything (total + every stage) is attributed to the
  // local date the session *ends* (the wake-up day), matching how sleep trackers show
  // "last night" and keeping stages aligned with the total. Natural key = time window.
  const sleepNights: { startMs: number; endMs: number; wakeDay: string }[] = [];
  for (const s of asArray(payload.sleep)) {
    const end =
      (typeof s.session_end_time === "string" && s.session_end_time) ||
      (typeof s.end_time === "string" && s.end_time) ||
      undefined;
    let start =
      (typeof s.start_time === "string" && s.start_time) ||
      (typeof s.session_start_time === "string" && s.session_start_time) ||
      undefined;
    let secs = num(s.duration_seconds, s.duration_sec);
    if (secs == null && start && end) secs = secondsBetween(start, end) ?? 0;
    // Derive a deterministic start from end − duration when only the end is given,
    // so the dedup key is stable across re-syncs.
    if (!start && end && secs != null) {
      const e = new Date(end).getTime();
      if (!Number.isNaN(e)) start = new Date(e - secs * 1000).toISOString();
    }
    const p = parts(end, tz);
    // Bound the total (minutes): a session can't exceed 24 h, so an absurd duration
    // is dropped and counted like a malformed one (#132).
    const sleepMin =
      secs != null ? boundedOrNull("sleep_min", Math.round(secs / 60)) : null;
    if (!p || !start || !end || secs == null || secs <= 0 || sleepMin == null) {
      out.skipped++;
      continue;
    }
    const wakeDay = p.date;
    // Remember the session window so a per-night reading timestamped INSIDE it (skin
    // temperature, below) can borrow this same wake-day attribution.
    const sessionStartMs = new Date(start).getTime();
    const sessionEndMs = new Date(end).getTime();
    if (!Number.isNaN(sessionStartMs) && !Number.isNaN(sessionEndMs)) {
      sleepNights.push({
        startMs: sessionStartMs,
        endMs: sessionEndMs,
        wakeDay,
      });
    }
    out.samples.push({
      metric: "sleep_min",
      date: wakeDay,
      start_time: start,
      end_time: end,
      value: sleepMin,
      origin: dataOrigin(s),
    });

    // Per-stage breakdown. Each stage carries its own start/end (+ duration); we key
    // on its window and pin its date to the session's wake day so it groups with the
    // total. Unknown / generic-"sleeping" stages classify to null and are skipped
    // here (still reflected in sleep_min).
    //
    // Stage minutes are stored EXACT (seconds/60), NOT rounded per stage (issue
    // the Fitbit-exporter payload audit). One row is emitted per stage and the read layer SUMs them, so rounding
    // each stage independently accumulates error across the whole night — and it
    // rounds UP hardest on the shortest stages, which is precisely what a real
    // wrist-tracker night is full of: a 62-stage Fitbit session with a dozen 30-second
    // awake micro-arousals stored 391 min of stages against a 377-min session, so the
    // breakdown out-summed the total it belongs to. Rounding happens ONCE now, on the
    // summed day totals in getSleepStageDailyTotals. The stored value still goes
    // through boundedOrNull, whose METRIC_ROUND_DP entry for these metrics bounds the
    // written precision so a re-send stays byte-identical (the #1109 discipline) and
    // the SELECT-before-compare upsert still counts it `unchanged`.
    for (const st of asArray(s.stages)) {
      const bucket = classifyStage(st.stage ?? st.type);
      const stStart =
        typeof st.start_time === "string" ? st.start_time : undefined;
      const stEnd = typeof st.end_time === "string" ? st.end_time : undefined;
      let stSecs = num(st.duration_seconds, st.duration_sec);
      if (stSecs == null && stStart && stEnd)
        stSecs = secondsBetween(stStart, stEnd) ?? 0;
      const stMetric = `sleep_${bucket}_min`;
      const stMin =
        stSecs != null ? boundedOrNull(stMetric, stSecs / 60) : null;
      if (
        !bucket ||
        !stStart ||
        !stEnd ||
        stSecs == null ||
        stSecs <= 0 ||
        stMin == null
      )
        continue;
      out.samples.push({
        metric: stMetric,
        date: wakeDay,
        start_time: stStart,
        end_time: stEnd,
        value: stMin,
        origin: dataOrigin(s),
      });
    }
  }

  // --- skin temperature variation → metric_samples (per NIGHT) ---
  //
  // NOT the "Body Temperature" vital. The record carries a SIGNED delta from the
  // tracker's own rolling personal baseline, so it has no absolute scale to flag
  // against: routed through medical_records it would be compared to a 97–99 °F
  // reference range and read as catastrophically abnormal. It is also a distinct
  // measurement SITE from core temperature, which the #482 exclusion discipline keeps
  // in its own identity rather than collapsing. Registered in AVERAGED_METRICS — a
  // SUMmed delta is meaningless (two +0.3 °C nights are not a +0.6 °C night).
  //
  // DAY ATTRIBUTION: a tracker emits ONE reading per night, stamped at sleep ONSET —
  // which is usually before local midnight, while the night's sleep total and HRV land
  // on the WAKE day. Taking the instant's own local date would chart the same night's
  // skin temperature one day left of its sleep and HRV, and would be actively wrong for
  // a variable sleeper: onsets at 23:50 and then 00:20 fall on the SAME local date, and
  // the per-day AVG would silently merge two different nights into one point (and leave
  // a hole). So a reading that falls inside a sleep session in this payload borrows that
  // session's wake day. This is an exact containment test, not a clock heuristic — the
  // exporter stamps the reading at the session start to the second. With no session in
  // the push (the types are independently toggleable) it falls back to its own local
  // date, which is the best available answer rather than a guess.
  for (const rec of asArray(payload.skin_temperature)) {
    const t = typeof rec.time === "string" ? rec.time : undefined;
    const p = parts(t, tz);
    const delta = boundedOrNull(
      SKIN_TEMP_DELTA_METRIC,
      num(rec.delta_celsius, rec.delta, rec.celsius, rec.value)
    );
    if (!p || !t || delta == null) {
      out.skipped++;
      continue;
    }
    const ms = new Date(t).getTime();
    const night = sleepNights.find((n) => ms >= n.startMs && ms <= n.endMs);
    out.samples.push({
      metric: SKIN_TEMP_DELTA_METRIC,
      date: night?.wakeDay ?? p.date,
      start_time: t,
      end_time: t,
      value: delta,
      origin: dataOrigin(rec),
    });
  }

  // --- continuous heart rate: bucket raw samples into 1-minute aggregates ---
  const buckets = new Map<
    string,
    { sum: number; n: number; min: number; max: number }
  >();
  const heartRateRecords = asArray(payload.heart_rate);
  let acceptedHeartRate = 0;
  for (const s of heartRateRecords) {
    const p = parts(s.time, tz);
    const bpm = boundedOrNull(
      "heart_rate_bpm",
      num(s.avg, s.bpm, s.beatsPerMinute, s.value)
    );
    if (!p || bpm == null) {
      out.skipped++;
      continue;
    }
    acceptedHeartRate++;
    const statedN = num(s.n, s.count, s.sample_count);
    const n =
      statedN != null && statedN > 0 ? Math.max(1, Math.round(statedN)) : 1;
    const statedMin = boundedOrNull("heart_rate_bpm", num(s.min));
    const statedMax = boundedOrNull("heart_rate_bpm", num(s.max));
    const min = statedMin ?? bpm;
    const max = statedMax ?? bpm;
    const b = buckets.get(p.minute);
    if (!b) buckets.set(p.minute, { sum: bpm * n, n, min, max });
    else {
      b.sum += bpm * n;
      b.n += n;
      b.min = Math.min(b.min, min);
      b.max = Math.max(b.max, max);
    }
  }
  if (heartRateRecords.length > 0 && acceptedHeartRate === 0) {
    out.details.warnings.push(
      "heart_rate records were all skipped — exporter shape not recognized"
    );
  }
  for (const [ts, b] of buckets) {
    out.hrMinutes.push({
      ts,
      bpm: b.sum / b.n,
      bpm_min: b.min,
      bpm_max: b.max,
      n: b.n,
    });
  }

  // --- exercise sessions → activities ---
  // Active-calorie records are independent intervals in Health Connect. A shared
  // start alone does not prove that a calorie interval describes an exercise, so
  // remember the complete original windows and attach a stable activity identity
  // only after an exact start+end match.
  const exerciseByWindow = new Map<string, string>();
  for (const e of asArray(payload.exercise)) {
    const start = typeof e.start_time === "string" ? e.start_time : undefined;
    const end = typeof e.end_time === "string" ? e.end_time : undefined;
    const p = parts(start, tz);
    if (!p || !start) {
      out.skipped++;
      continue;
    }
    const { type, title } = classifyExercise(e.type);
    const secs = num(e.duration_seconds, e.duration_sec);
    // Sanitize the optional duration/distance to null when physiologically absurd
    // (#132): the session itself is still valid (it has a start + type), so we drop
    // only the bad field rather than the whole activity.
    const duration_min = boundedOrNull(
      "duration_min",
      minutesBetween(start, end) ??
        (secs != null ? Math.round(secs / 60) : null)
    );
    const meters = num(e.distance_meters, e.meters, e.distance);
    const distance_km = boundedOrNull(
      "distance_km",
      meters != null ? meters / 1000 : null
    );
    const endParts = end ? parts(end, tz) : null;
    const externalId = `${HEALTH_CONNECT_ID}:${start}`;
    out.activities.push({
      external_id: externalId,
      date: p.date,
      type,
      title,
      duration_min,
      distance_km,
      start_time: p.hhmm,
      end_time: endParts?.hhmm ?? null,
    });
    if (end) exerciseByWindow.set(`${start}\0${end}`, externalId);
  }
  for (const sample of out.samples) {
    if (sample.metric !== "active_kcal") continue;
    sample.activity_external_id =
      exerciseByWindow.get(`${sample.start_time}\0${sample.end_time}`) ?? null;
  }

  out.details.origins = originChoices(out.samples);

  // Wrong-granularity diagnostics (#1065): read the raw payload shape and append any
  // actionable hints to the warnings surfaced in Data → Review. Informational only —
  // nothing here changes what was parsed or stored above.
  for (const hint of detectGranularityHints(payload)) {
    out.details.warnings.push(hint);
  }

  return out;
}
