import type { ActivityType } from "@/lib/types";
import { zonedDateParts, zonedMinuteStr } from "@/lib/date";
import { boundedOrNull, inTimeWindow } from "@/lib/ingest-bounds";
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
]);

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
}

// ---- local time helpers (day/minute attribution in the PROFILE's IANA timezone) ----
// The exporter sends absolute timestamps (with a Z/offset); the ingest route resolves
// the pushing profile from its token and passes that profile's timezone (the same
// resolution as today(profileId)), so we attribute each instant to a calendar day
// and minute in the PROFILE's zone, NOT the process TZ — an evening event lands on
// the right local day even though production Docker runs UTC, and steps/calories/
// sleep bucket to the same day as activities/doses/digests (issue #94). `date` feeds
// metric_samples.date; `minute` is the hr_minutes.ts bucket key (see zonedMinuteStr).

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
  return { date, minute: zonedMinuteStr(tz, d), hhmm };
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

function classifyExercise(rawType: unknown): {
  type: ActivityType;
  title: string;
} {
  const raw =
    typeof rawType === "string" && rawType.trim() ? rawType.trim() : "Workout";
  const norm = raw.toLowerCase();
  const title = raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const type: ActivityType = CARDIO_HINTS.some((h) => norm.includes(h))
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

  // --- vitals & biomarkers → medical_records (reference-range flagged) ---
  const vital = (
    key: string,
    canonical: string,
    category: "vitals" | "biomarker",
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
        category: "vitals",
        name: "Blood Pressure Diastolic",
        canonical: "Blood Pressure Diastolic",
        value_num: dia,
        unit: "mmHg",
      });
  }
  // Glucose mmol/L → mg/dL; body temperature °C → °F (canonical units).
  vital("blood_glucose", "Glucose", "biomarker", "mg/dL", (r) => {
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
  for (const h of asArray(payload.heart_rate_variability)) {
    const t = typeof h.time === "string" ? h.time : undefined;
    const p = parts(t, tz);
    const ms = boundedOrNull(
      "hrv_ms",
      num(h.milliseconds, h.ms, h.rmssd, h.value)
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
    });
  }

  // Sleep: total duration (minutes) per session → metric_samples 'sleep_min', plus a
  // per-stage breakdown → 'sleep_deep_min' / '_rem_' / '_light_' / '_awake_'. A
  // session spans midnight, so everything (total + every stage) is attributed to the
  // local date the session *ends* (the wake-up day), matching how sleep trackers show
  // "last night" and keeping stages aligned with the total. Natural key = time window.
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
    if (secs == null && start && end)
      secs = (minutesBetween(start, end) ?? 0) * 60;
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
    out.samples.push({
      metric: "sleep_min",
      date: wakeDay,
      start_time: start,
      end_time: end,
      value: sleepMin,
    });

    // Per-stage breakdown. Each stage carries its own start/end (+ duration); we key
    // on its window and pin its date to the session's wake day so it groups with the
    // total. Unknown / generic-"sleeping" stages classify to null and are skipped
    // here (still reflected in sleep_min).
    for (const st of asArray(s.stages)) {
      const bucket = classifyStage(st.stage ?? st.type);
      const stStart =
        typeof st.start_time === "string" ? st.start_time : undefined;
      const stEnd = typeof st.end_time === "string" ? st.end_time : undefined;
      let stSecs = num(st.duration_seconds, st.duration_sec);
      if (stSecs == null && stStart && stEnd)
        stSecs = (minutesBetween(stStart, stEnd) ?? 0) * 60;
      const stMetric = `sleep_${bucket}_min`;
      const stMin =
        stSecs != null
          ? boundedOrNull(stMetric, Math.round(stSecs / 60))
          : null;
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
      });
    }
  }

  // --- continuous heart rate: bucket raw samples into 1-minute aggregates ---
  const buckets = new Map<
    string,
    { sum: number; n: number; min: number; max: number }
  >();
  for (const s of asArray(payload.heart_rate)) {
    const p = parts(s.time, tz);
    const bpm = boundedOrNull(
      "heart_rate_bpm",
      num(s.bpm, s.beatsPerMinute, s.value)
    );
    if (!p || bpm == null) {
      out.skipped++;
      continue;
    }
    const b = buckets.get(p.minute);
    if (!b) buckets.set(p.minute, { sum: bpm, n: 1, min: bpm, max: bpm });
    else {
      b.sum += bpm;
      b.n += 1;
      b.min = Math.min(b.min, bpm);
      b.max = Math.max(b.max, bpm);
    }
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

  return out;
}
