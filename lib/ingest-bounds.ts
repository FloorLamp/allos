// Physiological plausibility bounds for integration ingest (issue #132).
//
// The push-ingest endpoints (Health Connect, Strava) validate STRUCTURE but not
// PLAUSIBILITY: `num()` accepts anything `Number.isFinite`, and date parsing only
// rejects `NaN`. So a buggy third-party phone exporter — the realistic threat, since
// the ingest endpoint exists precisely for third-party exporters — can land a
// 5,000 kg body weight, a 500 bpm resting heart rate, negative steps, an SpO2 of
// 900 %, or a year-3000 timestamp. Downstream, AI insights and biomarker flags
// consume these rows as ground truth, so one absurd stored value quietly poisons
// Trends, flags, and coaching output for a health app.
//
// This module is PURE (no @/lib/db, no I/O) so it lives in the unit tier
// (lib/__tests__/ingest-bounds.test.ts). The parsers call it at the point where a
// value has already been converted to its CANONICAL storage unit (kg, km, mg/dL,
// degF, …) — bounds are expressed in those same canonical units.
//
// GUIDING PRINCIPLE: bounds are CONSERVATIVE — a wide physiological envelope that
// rejects only the physically-impossible, never a plausible human outlier. Each
// bound below notes the real-world extreme it clears with margin (record-holders,
// clinical crisis values). When in doubt we widen: a rare-but-real value slipping
// through is far cheaper than silently dropping a legitimate reading. An
// out-of-bounds value is DROPPED and COUNTED as skipped, never clamped (a clamped
// value is a fabricated reading) and never fatal.

export interface MetricBound {
  min: number;
  max: number;
}

// Per-metric plausibility envelopes, keyed by the exact metric identifier the
// parsers use: metric_samples `metric` strings, medical_records `canonical` names,
// and the body_metrics / heart-rate / activity field keys. A metric ABSENT from
// this map is intentionally unbounded (passes through) — bounds are opt-in, so a
// newly-parsed metric is never silently dropped before someone curates its range.
export const METRIC_BOUNDS: Record<string, MetricBound> = {
  // ---- body_metrics ----
  // Lightest surviving newborn ≈0.25 kg; heaviest human ever ≈635 kg. 0.2–650
  // clears both with margin for any tracked human — the app tracks kids and ships
  // growth charts, so a premature / low-birth-weight infant weight (0.25–2 kg) is a
  // legitimate reading, not the "physically impossible" this envelope drops.
  weight_kg: { min: 0.2, max: 650 },
  // Body fat can't reach 0 % (essential fat ≈3 %); extreme obesity tops out ≈70 %.
  body_fat_pct: { min: 1, max: 75 },
  // Elite endurance resting HR ≈27 bpm; a resting reading above 250 is a sensor
  // fault, not a pulse (max attainable HR ≈220).
  resting_hr: { min: 20, max: 250 },

  // ---- continuous heart rate (hr_minutes raw samples) ----
  // Instantaneous HR can spike well above resting during arrhythmia (SVT ≈250–300);
  // 20–300 covers profound bradycardia through that, but rejects the classic 500 bpm
  // export bug.
  heart_rate_bpm: { min: 20, max: 300 },

  // ---- metric_samples: daily summable / scalar ----
  // A 24 h ultra-runner can log ~100 k+ steps; 200 k is a comfortable ceiling. Steps
  // are non-negative by definition.
  steps: { min: 0, max: 200_000 },
  // Multi-day adventure races aside, a single day rarely exceeds a few hundred km;
  // 1000 km/day rejects only the absurd.
  distance_km: { min: 0, max: 1000 },
  // A Tour de France stage burns ~8000 kcal; 30 k covers the most extreme day.
  active_kcal: { min: 0, max: 30_000 },
  total_kcal: { min: 0, max: 30_000 },
  // Water intoxication risk starts well under 10 L/day; 40 L is unmistakably a fault.
  hydration_l: { min: 0, max: 40 },

  // ---- metric_samples: nutrition (per day) ----
  nutrition_kcal: { min: 0, max: 40_000 },
  protein_g: { min: 0, max: 2000 },
  carbs_g: { min: 0, max: 5000 },
  fat_g: { min: 0, max: 2000 },
  sugar_g: { min: 0, max: 5000 },
  // Sodium is stored in GRAMS (typical intake 2–5 g); 100 g is clearly impossible.
  sodium_g: { min: 0, max: 100 },
  fiber_g: { min: 0, max: 500 },

  // ---- metric_samples: body composition (point) ----
  lean_mass_kg: { min: 1, max: 300 },
  // Adult skeletal mass ≈2–4 kg; 0.05–20 clears infants through the heaviest adult.
  bone_mass_kg: { min: 0.05, max: 20 },
  // BMR ≈1200–2000 kcal/day typically; 200–20 000 rejects only nonsense.
  bmr_kcal: { min: 200, max: 20_000 },
  // Shortest adult on record ≈55 cm, tallest ≈272 cm; 40–280 also admits infants.
  height_cm: { min: 40, max: 280 },

  // ---- metric_samples: HRV (point) ----
  // RMSSD is a few ms in severe autonomic dysfunction up to ~200 ms in the very
  // relaxed; 0–2000 stays generous while rejecting a runaway magnitude.
  hrv_ms: { min: 0, max: 2000 },

  // ---- metric_samples: sleep (minutes) ----
  // No sleep SESSION exceeds 24 h; every stage is bounded by the same 0–1440.
  sleep_min: { min: 0, max: 1440 },
  sleep_deep_min: { min: 0, max: 1440 },
  sleep_rem_min: { min: 0, max: 1440 },
  sleep_light_min: { min: 0, max: 1440 },
  sleep_awake_min: { min: 0, max: 1440 },

  // ---- medical_records: vitals & biomarkers (canonical units) ----
  // Glucose stored mg/dL: survivable hypo ≈20, severe DKA ≈1000+; 10–2000 covers it.
  Glucose: { min: 10, max: 2000 },
  // SpO2 is a percentage — it physically cannot exceed 100; profound hypoxia ≈50.
  "Oxygen Saturation": { min: 50, max: 100 },
  // Body temperature stored °F: survived extremes ≈56–115 °F; 77–113 °F (25–45 °C)
  // brackets every survivable core temperature.
  "Body Temperature": { min: 77, max: 113 },
  // Respiratory rate: apneic ≈3 up through severe tachypnea ≈80 breaths/min.
  "Respiratory Rate": { min: 3, max: 80 },
  // VO2 max: elite ≈90 mL/kg/min; 5–100 rejects only sensor nonsense.
  "VO2 Max": { min: 5, max: 100 },
  // Systolic: profound shock ≈40, hypertensive crisis ≈250 mmHg.
  "Blood Pressure Systolic": { min: 40, max: 300 },
  "Blood Pressure Diastolic": { min: 20, max: 200 },

  // ---- activity summary fields (Health Connect + Strava) ----
  // A single session — even a 48 h ultra — stays under 2880 min.
  duration_min: { min: 0, max: 2880 },
  // Downhill/track cycling peaks ≈130 km/h; 150 rejects only the impossible.
  speed_kmh: { min: 0, max: 150 },
  // Elevation gain: the biggest multi-day rides gain well under 20 000 m.
  elevation_m: { min: -1000, max: 20_000 },
  // Sprint peak power ≈2500 W; 3000 clears every pro effort.
  power_w: { min: 0, max: 3000 },
  cadence_rpm: { min: 0, max: 300 },
  // Ambient temperature during outdoor exercise, °C.
  temp_c: { min: -60, max: 60 },
  kilojoules: { min: 0, max: 50_000 },
};

// True when `value` is within the metric's registered plausibility envelope. An
// UNKNOWN metric (no registered bound) passes through as valid — bounds are opt-in.
// A non-finite value is always out of bounds.
export function inMetricBounds(metric: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const b = METRIC_BOUNDS[metric];
  if (!b) return true;
  return value >= b.min && value <= b.max;
}

// Convenience gate for the parsers: returns `value` when it is a finite, in-bounds
// number, else null. Because the parsers already treat a null value as a
// skipped/dropped record, wrapping a parsed value in this makes out-of-bounds
// values fold into the EXISTING skip-and-count path with no extra branching — a
// physiologically-impossible reading is dropped and reflected in the Review inbox's
// "· N skipped" segment, exactly like a malformed one.
export function boundedOrNull(
  metric: string,
  value: number | null
): number | null {
  if (value == null) return null;
  return inMetricBounds(metric, value) ? value : null;
}

// ---- timestamp sanity window ----
//
// A record's instant is attributed to a calendar day; a year-3000 or year-1850
// timestamp silently skews Trends windows, weekly recaps, and coaching insights.
// Accept an instant only when it is no earlier than 1900 and no more than one day
// in the future (device clock skew across time zones is at most ~26 h, so a full
// day of slack tolerates it without admitting a year-3000 export).

// 1900-01-01T00:00:00Z — the earliest plausible instant for any living tracker.
export const MIN_INGEST_TIME_MS = Date.UTC(1900, 0, 1);
// One day of future slack, covering device clock skew / time-zone offset.
export const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

// True when `ms` (epoch millis) falls in the acceptable window. `nowMs` is
// injectable for deterministic tests; it defaults to the wall clock.
export function inTimeWindow(ms: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(ms)) return false;
  return ms >= MIN_INGEST_TIME_MS && ms <= nowMs + FUTURE_SLACK_MS;
}

// ---- payload record-count cap ----
//
// A <2 MB payload still has NO record-count cap: every array is looped and upserted
// in one synchronous transaction, blocking the single better-sqlite3 connection for
// the whole batch. A rolling-48h export is a few thousand records at most, so 10 000
// is generous headroom while capping a runaway/hostile client. The ingest route
// rejects an over-cap payload with a 400 and a recorded failure event.
export const MAX_INGEST_RECORDS = 10_000;

// Count the records a Health Connect payload carries: the sum of the lengths of its
// top-level arrays, plus nested per-session sleep `stages` (the one nested array the
// parser loops). Pure and defensive — a non-object body, or a non-array/omitted key,
// contributes 0. This is an upper-bound proxy for the per-transaction upsert work,
// evaluated before parsing so an abusive batch is rejected before the write path.
export function countPayloadRecords(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  let total = 0;
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    total += value.length;
    // Sleep sessions each carry a nested `stages` array the parser also loops.
    for (const item of value) {
      if (item && typeof item === "object") {
        const stages = (item as Record<string, unknown>).stages;
        if (Array.isArray(stages)) total += stages.length;
      }
    }
  }
  return total;
}
