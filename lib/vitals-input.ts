// Pure validation + canonical-unit conversion for the manual "Log vitals"
// quick-add (issue #16). Mirrors lib/body-metric-input.ts: the addVitals server
// action normalizes the same raw fields, so the client form pre-validates with the
// exact same bounds to surface an inline error instead of a false "saved" toast.
// Kept DB-free and pure so it's unit-tested in lib/__tests__.
//
// CANONICAL STORAGE — these MUST match the Health Connect parser (lib/integrations/
// health-connect.ts) exactly, so a manually entered vital lands in the same table /
// metric key / canonical name / canonical unit as the integration's and shares its
// charts + reference-range flags:
//   • Blood Pressure Systolic / Diastolic → medical_records, category 'vitals',  mmHg
//   • Glucose                             → medical_records, category 'biomarker', mg/dL
//   • Oxygen Saturation (SpO2)            → medical_records, category 'vitals',  %
//   • Body Temperature                    → medical_records, category 'vitals',  degF
//   • Sleep duration                      → metric_samples,  metric 'sleep_min', minutes
//   • Heart rate variability (HRV)        → metric_samples,  metric 'hrv_ms',    ms
//   • Grip Strength                       → medical_records, category 'vitals',  kg
//   • 30-Second Chair Stand               → medical_records, category 'vitals',  reps
//   • Single-Leg Balance                  → medical_records, category 'vitals',  seconds
// The three functional-fitness markers (#158) are manual-only physical measurements
// stored in their canonical unit directly (no entry-unit selector); their age/sex
// PERCENTILE context comes from lib/fitness-norms.ts.
// Body temperature and glucose have internationally-varying entry units, so the form
// carries an explicit unit selector for each and converts to the canonical unit here
// (°C→°F, mmol/L→mg/dL). BP/SpO2/HRV/sleep have universal entry units.

import { inMetricBounds } from "./ingest-bounds";

export type TempUnit = "C" | "F";
export type GlucoseUnit = "mg/dL" | "mmol/L";

// A vital destined for medical_records (reference-range flagged). `canonical`/
// `unit`/`category` are the exact canonical shape the HC parser writes. `note` rides
// the row's `notes` column — for a temperature reading it's the profile-local "HH:MM"
// clock time (#800/#843), so repeat same-day readings build a fever curve. Absent for
// every other vital (and untimed temperatures), so it never widens the persisted row.
export interface VitalMedicalRow {
  canonical: string;
  category: "vitals" | "biomarker";
  unit: string;
  value_num: number; // canonical unit
  note?: string;
}

// A vital destined for metric_samples, keyed by `metric`. `value` is canonical.
export interface VitalSampleRow {
  metric: string;
  value: number;
}

export interface VitalsRawInput {
  systolic?: string | null;
  diastolic?: string | null;
  glucose?: string | null;
  glucoseUnit?: string | null; // 'mg/dL' | 'mmol/L' (defaults mg/dL)
  spo2?: string | null;
  temperature?: string | null;
  tempUnit?: string | null; // 'C' | 'F' (defaults F — the canonical/display unit)
  temperatureTime?: string | null; // optional "HH:MM" reading time (#800/#843 fever curve)
  sleepHours?: string | null;
  hrv?: string | null;
  gripStrength?: string | null; // kg
  chairStand?: string | null; // reps in 30 s
  balance?: string | null; // single-leg stance seconds
}

// Canonical names/units — the single source of truth shared by the action + tests,
// matching health-connect.ts so both writers agree byte-for-byte.
export const VITAL_CANONICAL = {
  systolic: {
    canonical: "Blood Pressure Systolic",
    category: "vitals" as const,
    unit: "mmHg",
  },
  diastolic: {
    canonical: "Blood Pressure Diastolic",
    category: "vitals" as const,
    unit: "mmHg",
  },
  glucose: {
    canonical: "Glucose",
    category: "biomarker" as const,
    unit: "mg/dL",
  },
  spo2: {
    canonical: "Oxygen Saturation",
    category: "vitals" as const,
    unit: "%",
  },
  temperature: {
    canonical: "Body Temperature",
    category: "vitals" as const,
    unit: "degF",
  },
  // Functional fitness markers (#158) — manual-entry physical measurements stored
  // in their canonical unit directly (no conversion). Each is a canonical biomarker
  // (see scripts/gen-canonical-biomarkers.ts CURATED_LABS) whose age/sex percentile
  // context comes from lib/datasets/data/fitness-norms.json; the names/units MUST match both.
  gripStrength: {
    canonical: "Grip Strength",
    category: "vitals" as const,
    unit: "kg",
  },
  chairStand: {
    canonical: "30-Second Chair Stand",
    category: "vitals" as const,
    unit: "reps",
  },
  balance: {
    canonical: "Single-Leg Balance",
    category: "vitals" as const,
    unit: "seconds",
  },
} as const;

export const SLEEP_METRIC = "sleep_min";
export const HRV_METRIC = "hrv_ms";

// °C → °F, rounded to 0.1 — identical to the Health Connect parser's conversion so
// a manual °C entry and a synced reading land on the same canonical degF scale.
export function celsiusToF(c: number): number {
  return Math.round((c * (9 / 5) + 32) * 10) / 10;
}

// mmol/L → mg/dL, rounded to 0.1 — matches the HC parser's 18.0156 factor.
export function mmolToMgdl(v: number): number {
  return Math.round(v * 18.0156 * 10) / 10;
}

// Canonical (°F) bounds a body-temperature reading must fall within. Shared by the
// Trends vitals form, the illness symptom-card quick entry (issue #800), and their
// tests so all three agree on what a plausible reading is (a superset-narrow of the
// ingest window 77–113 in lib/ingest-bounds.ts — 86 °F / 30 °C is the manual floor).
export const TEMP_MIN_F = 86;
export const TEMP_MAX_F = 113;

// Body-temperature entry ranges do not overlap across the two scales: a plausible
// Celsius reading converts into the canonical 86–113 °F window, while a plausible
// Fahrenheit reading already sits in that window. Detect only when exactly one
// interpretation is plausible; incomplete/out-of-range typing returns null so the UI
// keeps the selected preference and validation still owns the final decision.
export function detectTemperatureUnit(
  value: number | null | undefined
): TempUnit | null {
  if (value == null || !Number.isFinite(value)) return null;
  const plausibleF = temperatureRangeError(value) == null;
  const plausibleC = temperatureRangeError(celsiusToF(value)) == null;
  if (plausibleF === plausibleC) return null;
  return plausibleC ? "C" : "F";
}

export function resolveTemperatureUnit(
  value: number,
  selected: TempUnit | string | null | undefined
): TempUnit {
  return detectTemperatureUnit(value) ?? (selected === "C" ? "C" : "F");
}

// Convert an entered temperature to the canonical °F scale (issue #800). °C goes
// through celsiusToF (the exact Health Connect factor, 0.1 rounding) so a manual °C
// reading and a synced one land on the same scale; °F is already canonical. Anything
// but an explicit "C" is treated as °F (the default/canonical unit).
export function toCanonicalTempF(
  value: number,
  unit: TempUnit | string | null | undefined
): number {
  return unit === "C" ? celsiusToF(value) : value;
}

// ---- Imported / stored temperature units (#1018) ----------------------------
// The document-import boundary conversion and the stored-row read gate share ONE
// spelling recognizer, so "what counts as a temperature unit" can't fork.

// Unit spellings health-record documents actually ship for the two scales — UCUM
// ("Cel", "[degF]"), degree text ("°C", "deg F"), bare letters, and spelled-out
// forms. Matching strips every non-letter (the heightToCm precedent), so
// bracket/degree-sign/whitespace noise can't defeat recognition; an unrecognized
// spelling resolves to null and the caller NEVER guesses.
const TEMP_UNIT_SPELLINGS: Record<string, TempUnit> = {
  c: "C",
  cel: "C",
  degc: "C",
  celsius: "C",
  f: "F",
  degf: "F",
  fahrenheit: "F",
};

// The temperature scale a unit string denotes, or null when it isn't a recognized
// temperature spelling (never guess — the heightToCm skip-don't-guess posture).
export function recognizedTempUnit(
  unit: string | null | undefined
): TempUnit | null {
  if (!unit) return null;
  const u = unit.toLowerCase().replace(/[^a-z]/g, "");
  return TEMP_UNIT_SPELLINGS[u] ?? null;
}

// Convert one imported Body Temperature reading to the canonical-°F storage trio,
// or null when the reading must be stored VERBATIM instead: the unit spelling is
// unrecognized (storing an unconverted value as °F would be a guess), or the
// converted value falls outside the ingest plausibility band (junk must not enter
// the canonical series wearing a trusted 'degF' unit). This is the same
// write-boundary conversion every live-entry writer already performs (manual log,
// Telegram, Health Connect, Withings), applied to the CCDA/FHIR observation
// mappers (#1018) on the heightToCm/weightToKg model. The caller keys any dedup
// identity on the AS-SHIPPED value, not this result.
export function normalizeImportedTemperature(
  value_num: number | null | undefined,
  unit: string | null | undefined
): { value: string; value_num: number; unit: string } | null {
  if (value_num == null || !Number.isFinite(value_num)) return null;
  const tu = recognizedTempUnit(unit);
  if (!tu) return null;
  const degF = Math.round(toCanonicalTempF(value_num, tu) * 10) / 10;
  if (!inMetricBounds(VITAL_CANONICAL.temperature.canonical, degF)) return null;
  return {
    value: String(degF),
    value_num: degF,
    unit: VITAL_CANONICAL.temperature.unit,
  };
}

// A STORED Body Temperature row's value on the canonical °F scale, or null when
// the row can't be trusted as °F (#1018). A NULL/blank unit is trusted as
// canonical (every app writer stores 'degF'; older extracted rows may carry null —
// the pre-existing behavior, kept); a recognized non-canonical spelling converts
// (a legacy imported "38.5 Cel"); an unrecognized unit is EXCLUDED rather than
// plotted/red-flag-fed as °F. The one read gate for every consumer that builds a
// °F value from DB rows (the episode fever curve and anything after it).
export function storedTempToF(
  value_num: number,
  unit: string | null | undefined
): number | null {
  if (unit == null || unit.trim() === "") return value_num;
  const tu = recognizedTempUnit(unit);
  if (!tu) return null;
  return tu === "C" ? celsiusToF(value_num) : value_num;
}

// Range-check a canonical (°F) temperature. Returns the user-facing error or null —
// the one bounds check the vitals form, the quick entry, and the write core share.
export function temperatureRangeError(degF: number): string | null {
  return degF < TEMP_MIN_F || degF > TEMP_MAX_F
    ? "Body temperature is out of range."
    : null;
}

// Normalize a caller-supplied clock time to a canonical "HH:MM" (24h, zero-padded)
// string, or null when it isn't a plausible time. The ONE clock-time parser shared by
// the vitals temperature note and the temperature-log write core (#800/#843), so a
// native <input type="time"> value ("07:00") and a hand-typed "7:00" both land as the
// same day-agnostic display note. Never parsed for day attribution — that's `date`.
export function normalizeClockTime(
  time: string | null | undefined
): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function blank(v: string | null | undefined): boolean {
  return v == null || String(v).trim() === "";
}

function numOrNull(v: string | null | undefined): number | null {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Validate the raw form. Returns a human-readable error for the first problem, or
// null when the input is acceptable. Every field is optional individually, but at
// least one vital must be present, and blood pressure is a pair (both sides
// together). Bounds are on the CANONICAL value (after unit conversion).
export function validateVitalsInput(input: VitalsRawInput): string | null {
  const hasSys = !blank(input.systolic);
  const hasDia = !blank(input.diastolic);
  const anyOther = [
    input.glucose,
    input.spo2,
    input.temperature,
    input.sleepHours,
    input.hrv,
    input.gripStrength,
    input.chairStand,
    input.balance,
  ].some((v) => !blank(v));

  if (!hasSys && !hasDia && !anyOther) {
    return "Enter at least one vital.";
  }

  // Blood pressure — a reading is a systolic/diastolic pair.
  if (hasSys !== hasDia) {
    return "Enter both systolic and diastolic blood pressure.";
  }
  if (hasSys && hasDia) {
    const sys = numOrNull(input.systolic);
    const dia = numOrNull(input.diastolic);
    if (sys == null || sys < 40 || sys > 300) {
      return "Systolic must be between 40 and 300 mmHg.";
    }
    if (dia == null || dia < 20 || dia > 250) {
      return "Diastolic must be between 20 and 250 mmHg.";
    }
    if (dia >= sys) {
      return "Systolic must be greater than diastolic.";
    }
  }

  if (!blank(input.glucose)) {
    const raw = numOrNull(input.glucose);
    if (raw == null || raw <= 0) return "Enter a valid glucose value.";
    const mgdl = input.glucoseUnit === "mmol/L" ? mmolToMgdl(raw) : raw;
    if (mgdl < 20 || mgdl > 1000) {
      return "Glucose is out of range.";
    }
  }

  if (!blank(input.spo2)) {
    const v = numOrNull(input.spo2);
    if (v == null || v < 50 || v > 100) {
      return "Oxygen saturation must be between 50 and 100%.";
    }
  }

  if (!blank(input.temperature)) {
    const raw = numOrNull(input.temperature);
    if (raw == null) return "Enter a valid temperature.";
    const unit = resolveTemperatureUnit(raw, input.tempUnit);
    const err = temperatureRangeError(toCanonicalTempF(raw, unit));
    if (err) return err;
  }

  if (!blank(input.sleepHours)) {
    const v = numOrNull(input.sleepHours);
    if (v == null || v <= 0 || v > 24) {
      return "Sleep must be between 0 and 24 hours.";
    }
  }

  if (!blank(input.hrv)) {
    const v = numOrNull(input.hrv);
    if (v == null || v <= 0 || v > 500) {
      return "HRV must be between 1 and 500 ms.";
    }
  }

  if (!blank(input.gripStrength)) {
    const v = numOrNull(input.gripStrength);
    if (v == null || v <= 0 || v > 150) {
      return "Grip strength must be between 1 and 150 kg.";
    }
  }

  if (!blank(input.chairStand)) {
    const v = numOrNull(input.chairStand);
    if (v == null || v < 0 || v > 100 || !Number.isInteger(v)) {
      return "Chair stands must be a whole number between 0 and 100.";
    }
  }

  if (!blank(input.balance)) {
    const v = numOrNull(input.balance);
    if (v == null || v < 0 || v > 600) {
      return "Balance time must be between 0 and 600 seconds.";
    }
  }

  return null;
}

export interface NormalizedVitals {
  medical: VitalMedicalRow[];
  samples: VitalSampleRow[];
}

// Convert a validated raw form into the canonical rows to persist. Returns a
// discriminated union: `{ error }` when validation fails (so the caller never
// writes a partial/invalid set), else the normalized medical + sample rows. Callers
// attach date / profile / source at the DB boundary.
export function normalizeVitalsInput(
  input: VitalsRawInput
): { error: string } | NormalizedVitals {
  const error = validateVitalsInput(input);
  if (error) return { error };

  const medical: VitalMedicalRow[] = [];
  const samples: VitalSampleRow[] = [];

  const sys = numOrNull(input.systolic);
  const dia = numOrNull(input.diastolic);
  if (sys != null && dia != null) {
    medical.push({ ...VITAL_CANONICAL.systolic, value_num: sys });
    medical.push({ ...VITAL_CANONICAL.diastolic, value_num: dia });
  }

  const glucoseRaw = numOrNull(input.glucose);
  if (glucoseRaw != null) {
    const value =
      input.glucoseUnit === "mmol/L" ? mmolToMgdl(glucoseRaw) : glucoseRaw;
    medical.push({ ...VITAL_CANONICAL.glucose, value_num: value });
  }

  const spo2 = numOrNull(input.spo2);
  if (spo2 != null) {
    medical.push({ ...VITAL_CANONICAL.spo2, value_num: spo2 });
  }

  const tempRaw = numOrNull(input.temperature);
  if (tempRaw != null) {
    // A timed reading rides its "HH:MM" clock time on the row's note for the fever
    // curve (#800/#843); an untimed one leaves `note` absent so the persisted row is
    // unchanged. Only temperature carries a time (the only vital with a fever curve).
    const note = normalizeClockTime(input.temperatureTime);
    medical.push({
      ...VITAL_CANONICAL.temperature,
      value_num: toCanonicalTempF(
        tempRaw,
        resolveTemperatureUnit(tempRaw, input.tempUnit)
      ),
      ...(note ? { note } : {}),
    });
  }

  const sleepHours = numOrNull(input.sleepHours);
  if (sleepHours != null) {
    samples.push({ metric: SLEEP_METRIC, value: Math.round(sleepHours * 60) });
  }

  const hrv = numOrNull(input.hrv);
  if (hrv != null) {
    samples.push({ metric: HRV_METRIC, value: hrv });
  }

  const grip = numOrNull(input.gripStrength);
  if (grip != null) {
    medical.push({ ...VITAL_CANONICAL.gripStrength, value_num: grip });
  }

  const chair = numOrNull(input.chairStand);
  if (chair != null) {
    medical.push({ ...VITAL_CANONICAL.chairStand, value_num: chair });
  }

  const bal = numOrNull(input.balance);
  if (bal != null) {
    medical.push({ ...VITAL_CANONICAL.balance, value_num: bal });
  }

  return { medical, samples };
}
