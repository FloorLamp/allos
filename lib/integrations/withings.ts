import { zonedDateParts } from "@/lib/date";
import { boundedOrNull, inTimeWindow } from "@/lib/ingest-bounds";
import type { NormBodyMetric, NormMetricSample, NormVital } from "./normalize";

// Maps Withings API responses (https://developer.withings.com/api-reference) into
// the provider-agnostic normalized records (see normalize.ts), so the shared
// upserts handle all of the DB mapping and idempotency. Mirrors the Oura/Strava
// parsers: tolerant field reads, timezone-aware day attribution, and canonical-unit
// conversion at the boundary. This module is PURE (no @/lib/db, no fetch) so it
// lives in the unit tier (lib/__tests__/withings.test.ts).
//
// Withings encodes every measured quantity as { value, unit }: the real value is
// value × 10^unit (e.g. { value: 70500, unit: -3 } = 70.5 kg). Measurements arrive
// grouped (a "measuregrp" = one reading session on one device), each carrying a unix
// `date` and — since the device knows its own zone — a `timezone`, so we attribute
// the reading to the right local day regardless of the process TZ.

export const WITHINGS_ID = "withings";

// ---- Withings measure type codes (getmeas `type`) ----
// https://developer.withings.com/api-reference/#tag/measure
export const MEAS_WEIGHT = 1; // kg
export const MEAS_LEAN_MASS = 5; // kg (fat-free mass) → metric_samples lean_mass_kg
export const MEAS_FAT_RATIO = 6; // %
export const MEAS_DIASTOLIC_BP = 9; // mmHg
export const MEAS_SYSTOLIC_BP = 10; // mmHg
export const MEAS_HEART_PULSE = 11; // bpm
export const MEAS_SPO2 = 54; // %
export const MEAS_BODY_TEMP = 71; // °C (stored canonical as °F)
export const MEAS_MUSCLE_MASS = 76; // kg → metric_samples muscle_mass_kg
export const MEAS_HYDRATION = 77; // kg (total body water) → metric_samples body_water_kg
export const MEAS_BONE_MASS = 88; // kg → metric_samples bone_mass_kg
export const MEAS_VO2MAX = 123; // mL/kg/min → VO2 Max biomarker vital

// The measure types we request (a focused `meastypes` CSV keeps responses lean). The
// body-composition types (lean/muscle/bone mass, hydration, VO2max) join weight/fat%
// so a body-comp scale user gets the full composition set the device measures, not
// just weight + body fat (issue #419).
export const WITHINGS_MEAS_TYPES = [
  MEAS_WEIGHT,
  MEAS_LEAN_MASS,
  MEAS_FAT_RATIO,
  MEAS_DIASTOLIC_BP,
  MEAS_SYSTOLIC_BP,
  MEAS_HEART_PULSE,
  MEAS_SPO2,
  MEAS_BODY_TEMP,
  MEAS_MUSCLE_MASS,
  MEAS_HYDRATION,
  MEAS_BONE_MASS,
  MEAS_VO2MAX,
] as const;

// The sleep-summary data fields we request (v2/sleep getsummary `data_fields`).
export const WITHINGS_SLEEP_FIELDS = [
  "deepsleepduration",
  "lightsleepduration",
  "remsleepduration",
  "wakeupduration",
] as const;

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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayStr(v: unknown): string | null {
  const s = str(v);
  return s && DAY_RE.test(s) ? s : null;
}

function secToMin(sec: number | null): number | null {
  return sec == null ? null : Math.round(sec / 60);
}

function round(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

// Resolve a Withings unix timestamp (seconds) + IANA timezone to a local calendar
// day, wall-clock HH:MM, and the true ISO instant (the natural key for windowed
// samples). Rejects a year-3000 / pre-1900 instant (#132) so a garbage `date` can't
// skew day attribution — the caller folds a null into its skip-and-count path.
export function localFromUnix(
  unixSec: number | null,
  tz: string
): { date: string; hhmm: string; iso: string } | null {
  if (unixSec == null || !Number.isFinite(unixSec)) return null;
  const ms = unixSec * 1000;
  if (!inTimeWindow(ms)) return null;
  const d = new Date(ms);
  const { date, hhmm } = zonedDateParts(tz, d);
  return { date, hhmm, iso: d.toISOString() };
}

// ---- measures ----

// A single measure's real value: Withings encodes it as value × 10^unit.
function measureValue(m: unknown): { type: number; value: number } | null {
  if (!m || typeof m !== "object") return null;
  const rec = m as Record<string, unknown>;
  const type = num(rec.type);
  const value = num(rec.value);
  const unit = num(rec.unit) ?? 0;
  if (type == null || value == null) return null;
  return { type, value: value * Math.pow(10, unit) };
}

// Map ONE Withings measure group into a per-day body-metrics row (weight / body fat
// / heart pulse → resting HR) plus any clinical vitals (BP, SpO2, body temperature →
// medical_records). Returns null when the group has no usable timestamp/id or maps
// to nothing (the caller counts it skipped). Body-metric rows for the same local day
// merge in the shared upsert; each vital carries a per-analyte external_id so BP's
// two readings from one group stay distinct and dedup on re-sync.
export function mapWithingsMeasureGroup(
  group: unknown,
  defaultTz: string
): {
  bodyMetric: NormBodyMetric | null;
  vitals: NormVital[];
  samples: NormMetricSample[];
} | null {
  if (!group || typeof group !== "object") return null;
  const rec = group as Record<string, unknown>;
  const grpid = num(rec.grpid);
  const tz = str(rec.timezone) ?? defaultTz;
  const loc = localFromUnix(num(rec.date), tz);
  if (grpid == null || !loc) return null;

  // Last-writer-wins per type within a group (a group is one reading session, so a
  // type appears at most once in practice; the Map keeps it robust regardless).
  const byType = new Map<number, number>();
  const measures = Array.isArray(rec.measures) ? rec.measures : [];
  for (const m of measures) {
    const mv = measureValue(m);
    if (mv) byType.set(mv.type, mv.value);
  }

  const weight = boundedOrNull("weight_kg", byType.get(MEAS_WEIGHT) ?? null);
  const bodyFat = boundedOrNull(
    "body_fat_pct",
    byType.get(MEAS_FAT_RATIO) ?? null
  );
  const restingHr = boundedOrNull(
    "resting_hr",
    round(byType.get(MEAS_HEART_PULSE) ?? null)
  );
  const bodyMetric: NormBodyMetric | null =
    weight != null || bodyFat != null || restingHr != null
      ? {
          date: loc.date,
          ...(weight != null ? { weight_kg: weight } : {}),
          ...(bodyFat != null ? { body_fat_pct: bodyFat } : {}),
          ...(restingHr != null ? { resting_hr: restingHr } : {}),
        }
      : null;

  const vitals: NormVital[] = [];
  const pushVital = (
    canonical: string,
    unit: string,
    value: number | null,
    category: "vitals" | "biomarker" = "vitals"
  ) => {
    if (value == null) return;
    vitals.push({
      external_id: `${WITHINGS_ID}:${grpid}:${canonical}`,
      date: loc.date,
      category,
      name: canonical,
      canonical,
      value_num: value,
      unit,
    });
  };

  // Point body-composition metrics (one reading per weigh-in) → metric_samples,
  // keyed on the group's instant so a re-fetch dedups in the shared upsert. lean/bone
  // mass reuse the existing metric vocab (charted on Trends → Body); muscle mass and
  // total body water are captured under their own metric strings (issue #419).
  const samples: NormMetricSample[] = [];
  const pushSample = (metric: string, value: number | null) => {
    if (value == null) return;
    samples.push({
      metric,
      date: loc.date,
      start_time: loc.iso,
      end_time: loc.iso,
      value,
    });
  };
  pushSample(
    "lean_mass_kg",
    boundedOrNull("lean_mass_kg", byType.get(MEAS_LEAN_MASS) ?? null)
  );
  pushSample(
    "bone_mass_kg",
    boundedOrNull("bone_mass_kg", byType.get(MEAS_BONE_MASS) ?? null)
  );
  pushSample(
    "muscle_mass_kg",
    boundedOrNull("muscle_mass_kg", byType.get(MEAS_MUSCLE_MASS) ?? null)
  );
  // Withings type 77 "Hydration" is TOTAL BODY WATER in kg (value × 10^unit), NOT
  // drinking-water intake — so it maps to its own body_water_kg metric, never the
  // intake-oriented hydration_l vocab (whose 0–40 L envelope + additive semantics
  // would mislabel a ~40 kg body-water reading as 40 L drunk).
  pushSample(
    "body_water_kg",
    boundedOrNull("body_water_kg", byType.get(MEAS_HYDRATION) ?? null)
  );

  pushVital(
    "Blood Pressure Systolic",
    "mmHg",
    boundedOrNull(
      "Blood Pressure Systolic",
      round(byType.get(MEAS_SYSTOLIC_BP) ?? null)
    )
  );
  pushVital(
    "Blood Pressure Diastolic",
    "mmHg",
    boundedOrNull(
      "Blood Pressure Diastolic",
      round(byType.get(MEAS_DIASTOLIC_BP) ?? null)
    )
  );
  pushVital(
    "Oxygen Saturation",
    "%",
    boundedOrNull("Oxygen Saturation", byType.get(MEAS_SPO2) ?? null)
  );
  // Withings reports body temperature in °C; canonical storage is °F.
  const tempC = byType.get(MEAS_BODY_TEMP);
  pushVital(
    "Body Temperature",
    "degF",
    boundedOrNull(
      "Body Temperature",
      tempC != null ? Math.round(((tempC * 9) / 5 + 32) * 10) / 10 : null
    )
  );
  // VO2 max → the supported biomarker vital (same canonical + category as the Health
  // Connect vo2_max mapping), so a scale/watch estimate lands with lab/manual readings.
  pushVital(
    "VO2 Max",
    "mL/kg/min",
    boundedOrNull("VO2 Max", byType.get(MEAS_VO2MAX) ?? null),
    "biomarker"
  );

  if (!bodyMetric && vitals.length === 0 && samples.length === 0) return null;
  return { bodyMetric, vitals, samples };
}

// ---- sleep ----

const WITHINGS_STAGE_METRIC: Record<string, string> = {
  deepsleepduration: "sleep_deep_min",
  remsleepduration: "sleep_rem_min",
  lightsleepduration: "sleep_light_min",
  wakeupduration: "sleep_awake_min",
};

// Map one Withings sleep-summary series (v2/sleep getsummary) into nightly
// metric_samples: a total plus the deep/REM/light/awake stage breakdown (all
// minutes, matching the Health Connect / Oura sleep vocab). Total is the sum of the
// deep/REM/light stages (awake is excluded, like the wake-up time). Attributed to
// the series' `date` (Withings' night-of day, matching how sleep trackers show "last
// night"); the natural key is the sleep window (start/end instants), so a re-fetched
// night dedups. Resting HR is deliberately NOT taken here — it comes from the morning
// scale/BP heart-pulse measure so a single (date, source) body-metrics row has one
// writer.
export function mapWithingsSleep(
  series: unknown,
  defaultTz: string
): { samples: NormMetricSample[] } | null {
  if (!series || typeof series !== "object") return null;
  const rec = series as Record<string, unknown>;
  const id = num(rec.id);
  const tz = str(rec.timezone) ?? defaultTz;
  const start = localFromUnix(num(rec.startdate), tz);
  const end = localFromUnix(num(rec.enddate), tz);
  const date = dayStr(rec.date) ?? end?.date ?? null;
  if (id == null || !start || !end || !date) return null;

  const data =
    rec.data && typeof rec.data === "object"
      ? (rec.data as Record<string, unknown>)
      : {};

  const stageMin: Record<string, number | null> = {};
  for (const field of Object.keys(WITHINGS_STAGE_METRIC)) {
    stageMin[field] = secToMin(num(data[field]));
  }
  // Total sleep = deep + REM + light (awake excluded).
  const total =
    (stageMin.deepsleepduration ?? 0) +
    (stageMin.remsleepduration ?? 0) +
    (stageMin.lightsleepduration ?? 0);
  const totalMin = boundedOrNull("sleep_min", total > 0 ? total : null);
  if (totalMin == null) return null;

  const samples: NormMetricSample[] = [];
  const push = (metric: string, value: number | null) => {
    if (value != null)
      samples.push({
        metric,
        date,
        start_time: start.iso,
        end_time: end.iso,
        value,
      });
  };
  push("sleep_min", totalMin);
  for (const [field, metric] of Object.entries(WITHINGS_STAGE_METRIC)) {
    push(metric, boundedOrNull(metric, stageMin[field]));
  }

  return { samples };
}
