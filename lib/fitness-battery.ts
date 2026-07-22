// The guided Fitness-check test battery (issue #834) — the curated dataset that drives
// the flow: for each test, its tier, domain, instructions, input kind, natural STORE
// target, optional norms marker, and citation. Pure + DB-free (imports only other pure
// modules), so the dataset resolves against the scoring engines in a unit test.
//
// Design invariants this module encodes:
//   • VALUES write through NATURAL stores — never a parallel value table. A test's
//     `store` says where its measured value lands: a `set` on the assessment activity (a
//     genuine bodyweight/resistance exercise with a training series, #482), a `vital`
//     medical_records row under a canonical name the fitness-norms engine reads, or a
//     `body_metrics` column.
//   • The TIERS map to scoring: `norms` → fitnessPercentile/fitnessAge over a
//     `normsMarker`; `standard` → strength-standards e1RM bands; `evidence` → a cited
//     single-test scale (SRT 0-10, HRR bands, STEADI 4-stage) that is NOT a percentile;
//     `body` → body composition/vitals against canonical ranges; `self-norm` → a
//     DISCLOSED-ROUGH population band ladder (dead hang / plank — weak/fair/good/excellent
//     via lib/fitness-hold-norms, #1135) PLUS the retained personal delta; `self-trend` →
//     vs the user's own prior checks ONLY, no reference at all (currently unused —
//     reserved for a future genuinely reference-less test). The self-norm/self-trend split
//     keeps the RDA-adequacy honesty discipline: a disclosed rough band is NOT a fabricated
//     percentile, and a truly reference-less test still gets no invented number.
//   • AGE-BANDED swap: `batteryForAge(age)` returns the adult OR the senior variant
//     (Senior Fitness Test / CDC STEADI shapes past OLDER_ADULT_MIN_AGE) so the check
//     never hands a 78-year-old a Cooper run and a dead hang.

import { FITNESS_NORM_MARKERS } from "@/lib/fitness-norms";
import { OLDER_ADULT_MIN_AGE } from "@/lib/life-stage";
import type { Sex } from "@/lib/types";
import {
  cooperVo2,
  rockportWalkVo2,
  queensStepVo2,
  type Vo2Estimate,
} from "@/lib/vo2-field-tests";

// The scoring tiers (see the header). `self-norm` (#1135) is the rough-band ladder for the
// two isometric holds; `self-trend` is the reference-less residue (currently unused).
export type FitnessTier =
  | "norms"
  | "standard"
  | "evidence"
  | "body"
  | "self-norm"
  | "self-trend";

// The per-domain profile the check feeds (per-domain FitnessPercentile bars; NO new
// aggregate — fitness age stays the only headline).
export type FitnessDomain =
  "endurance" | "strength" | "balance" | "flexibility" | "mobility" | "body";

// Which battery variant a test belongs to. `both` tests appear in adult AND senior
// batteries; `adult`/`senior` are swapped by `batteryForAge`.
export type FitnessAgeBand = "adult" | "senior" | "both";

// How the user enters the measurement.
//   reps/seconds/number → a single numeric field (canonical unit is `unit`).
//   e1rm → the big-lift test: pick a lift + weight + reps → estimate1RM.
//   vo2  → VO2 Max via a watch value OR a cited field test (see VO2_METHODS).
//   hrr  → two heart rates (peak + 1-minute) → recovery delta.
export type FitnessInputKind =
  "reps" | "seconds" | "number" | "e1rm" | "vo2" | "hrr";

// Where a test's value lands. `set` → exercise_sets on the assessment activity (keyed by
// the lift's exerciseHistoryKey); `vital` → a medical_records canonical row (category
// vitals/biomarker); `body` → a body_metrics column.
export type FitnessStore =
  | { kind: "set"; lift: string; timed: boolean }
  | { kind: "vital"; canonical: string; category: "vitals" | "biomarker" }
  | { kind: "body"; column: "body_fat_pct" | "resting_hr" };

export interface FitnessTestDef {
  key: string; // stable within a session (UNIQUE(assessment_id, test_key))
  label: string;
  tier: FitnessTier;
  domain: FitnessDomain;
  ageBand: FitnessAgeBand;
  unit: string; // canonical stored unit
  inputKind: FitnessInputKind;
  instructions: string[];
  // Norms-tier only: the fitness-norms marker the entered value scores against. MUST be
  // absent on non-norms tiers (self-norm/self-trend carry NO percentile path).
  normsMarker?: string;
  // Self-norm-tier only (#1135): the lib/fitness-hold-norms entry key ("deadhang"/"plank")
  // whose rough band ladder colors the value. Absent on every other tier.
  holdNorm?: string;
  // Standard-tier only: uses strength-standards over the chosen lift's e1RM.
  standard?: boolean;
  store: FitnessStore;
  citation?: string;
  // A short "how to interpret" note for evidence-tier tests (SRT/HRR/4-stage).
  interpretation?: string;
  // Whether a LOWER measured value is fitter (timed up-and-go, resting HR, body fat), so
  // the surface colors a check-over-check delta correctly. Default false (higher better).
  lowerIsBetter?: boolean;
  // Equipment the test wants; when the profile's registry lacks it the UI offers the
  // documented substitute (equipment-aware, #834).
  equipment?: { needs: string; substitute: string };
  min?: number;
  max?: number;
}

// ── VO2 Max field-test methods ────────────────────────────────────────────────────
// The VO2 test accepts a directly-reported watch value OR one of three cited field
// tests. `seniorSafe` gates the maximal Cooper run out of the senior battery.
export type Vo2Method = "watch" | "cooper" | "rockport" | "step";

export interface Vo2MethodDef {
  key: Vo2Method;
  label: string;
  seniorSafe: boolean;
  instructions: string[];
}

export const VO2_METHODS: Vo2MethodDef[] = [
  {
    key: "watch",
    label: "Watch / device value",
    seniorSafe: true,
    instructions: [
      "Enter the VO2 Max your watch or fitness device reports (mL/kg/min).",
    ],
  },
  {
    key: "cooper",
    label: "Cooper 12-minute run",
    seniorSafe: false,
    instructions: [
      "Warm up, then run/walk as far as you can in exactly 12 minutes on a flat course or track.",
      "Enter the total distance covered in meters.",
    ],
  },
  {
    key: "rockport",
    label: "Rockport 1-mile walk",
    seniorSafe: true,
    instructions: [
      "Walk 1 mile (1.6 km) as briskly as you can on a flat course.",
      "Enter your finishing time (minutes) and your heart rate right at the finish.",
    ],
  },
  {
    key: "step",
    label: "3-minute step test",
    seniorSafe: true,
    instructions: [
      "Step up-and-down on a ~40 cm step for 3 minutes at a steady cadence (24/min men, 22/min women).",
      "Sit, wait 5 seconds, then measure your recovery heart rate; enter it here.",
    ],
  },
];

// Compute a VO2 Max (mL/kg/min) from a chosen method + raw inputs. Returns the estimate
// (with its cited method) or null when an input is missing — the write path then rejects
// the entry rather than storing a guess. `watch` is the value verbatim.
export function computeVo2(
  method: Vo2Method,
  inputs: {
    watchValue?: number | null;
    distanceMeters?: number | null;
    walkTimeMin?: number | null;
    walkHr?: number | null;
    weightLb?: number | null;
    stepRecoveryHr?: number | null;
  },
  sex: Sex | null,
  age: number | null
): Vo2Estimate | null {
  switch (method) {
    case "watch":
      return inputs.watchValue != null &&
        Number.isFinite(inputs.watchValue) &&
        inputs.watchValue > 0
        ? {
            vo2: Math.round(inputs.watchValue * 10) / 10,
            method: "Device-reported",
            citation: "",
          }
        : null;
    case "cooper":
      return cooperVo2(inputs.distanceMeters);
    case "rockport":
      return rockportWalkVo2({
        weightLb: inputs.weightLb,
        age,
        sex,
        timeMin: inputs.walkTimeMin,
        heartRate: inputs.walkHr,
      });
    case "step":
      return queensStepVo2(inputs.stepRecoveryHr, sex);
    default:
      return null;
  }
}

// ── The battery ───────────────────────────────────────────────────────────────────
// One curated list; `batteryForAge` slices it into the adult / senior variant. Order is
// the display order (grouped roughly by domain).
export const FITNESS_BATTERY: FitnessTestDef[] = [
  {
    key: "vo2max",
    label: "VO2 Max",
    tier: "norms",
    domain: "endurance",
    ageBand: "both",
    unit: "mL/kg/min",
    inputKind: "vo2",
    normsMarker: "VO2 Max",
    store: { kind: "vital", canonical: "VO2 Max", category: "biomarker" },
    citation: "Field estimates: Cooper 1968; Kline 1987; McArdle 1972.",
    instructions: [
      "Cardiorespiratory fitness — the single strongest longevity predictor.",
      "Use your watch's VO2 Max, or perform one of the field tests.",
    ],
    min: 5,
    max: 90,
  },
  {
    key: "hrr",
    label: "1-minute heart-rate recovery",
    tier: "evidence",
    domain: "endurance",
    ageBand: "both",
    unit: "bpm",
    inputKind: "hrr",
    store: {
      kind: "vital",
      canonical: "1-Minute Heart Rate Recovery",
      category: "vitals",
    },
    citation: "Cole et al., N Engl J Med 1999.",
    interpretation:
      "A 1-minute recovery of 12 bpm or less predicts higher mortality.",
    instructions: [
      "Right after a hard effort (e.g. the step test), note your peak heart rate.",
      "Rest for exactly 1 minute, then measure your heart rate again. Enter both.",
    ],
    min: 0,
    max: 120,
  },
  {
    key: "grip",
    label: "Grip strength",
    tier: "norms",
    domain: "strength",
    ageBand: "both",
    unit: "kg",
    inputKind: "number",
    normsMarker: "Grip Strength",
    store: { kind: "vital", canonical: "Grip Strength", category: "vitals" },
    instructions: [
      "Squeeze a hand dynamometer as hard as you can; use your best of 2-3 tries on your stronger hand.",
      "Enter the reading in kilograms.",
    ],
    equipment: {
      needs: "hand dynamometer",
      substitute:
        "Skip if you have no dynamometer — grip has no reliable substitute test.",
    },
    min: 1,
    max: 150,
  },
  {
    key: "pushups",
    label: "Max push-ups",
    tier: "norms",
    domain: "strength",
    ageBand: "adult",
    unit: "reps",
    inputKind: "reps",
    normsMarker: "Max Push-Ups",
    store: { kind: "set", lift: "Push Up", timed: false },
    citation: "ACSM / CSEP push-up norms.",
    instructions: [
      "Do as many full push-ups as you can with good form, without stopping.",
      "Enter the total number completed.",
    ],
    min: 0,
    max: 200,
  },
  {
    key: "chairstand",
    label: "30-second chair stand",
    tier: "norms",
    domain: "strength",
    ageBand: "both",
    unit: "reps",
    inputKind: "reps",
    normsMarker: "30-Second Chair Stand",
    store: {
      kind: "vital",
      canonical: "30-Second Chair Stand",
      category: "vitals",
    },
    instructions: [
      "From a standard chair, arms crossed on your chest, stand fully and sit back down as many times as you can in 30 seconds.",
      "Enter the number of full stands.",
    ],
    min: 0,
    max: 60,
  },
  {
    key: "armcurl",
    label: "30-second arm curl",
    tier: "norms",
    domain: "strength",
    ageBand: "senior",
    unit: "reps",
    inputKind: "reps",
    normsMarker: "30-Second Arm Curl",
    store: {
      kind: "vital",
      canonical: "30-Second Arm Curl",
      category: "vitals",
    },
    citation: "Rikli & Jones Senior Fitness Test.",
    instructions: [
      "Seated, curl a light dumbbell (5 lb women / 8 lb men) through full range as many times as you can in 30 seconds.",
      "Enter the number of full curls.",
    ],
    min: 0,
    max: 60,
  },
  {
    key: "biglift",
    label: "One big lift (e1RM)",
    tier: "standard",
    domain: "strength",
    ageBand: "both",
    unit: "kg",
    inputKind: "e1rm",
    standard: true,
    store: { kind: "set", lift: "", timed: false }, // lift chosen at entry time
    instructions: [
      "Pick a main barbell lift (squat, bench, deadlift, overhead press) and log a heavy set — the weight and reps.",
      "We'll estimate your 1RM and place it against strength standards for your bodyweight.",
    ],
  },
  {
    key: "vo2step2min",
    label: "2-minute step",
    tier: "norms",
    domain: "endurance",
    ageBand: "senior",
    unit: "reps",
    inputKind: "reps",
    normsMarker: "2-Minute Step",
    store: { kind: "vital", canonical: "2-Minute Step", category: "vitals" },
    citation: "Rikli & Jones Senior Fitness Test.",
    instructions: [
      "March in place for 2 minutes, raising each knee to the midpoint between kneecap and hip.",
      "Count the number of times your RIGHT knee reaches that height; enter it.",
    ],
    min: 0,
    max: 250,
  },
  {
    key: "balance",
    label: "Single-leg balance",
    tier: "norms",
    domain: "balance",
    ageBand: "both",
    unit: "seconds",
    inputKind: "seconds",
    normsMarker: "Single-Leg Balance",
    store: {
      kind: "vital",
      canonical: "Single-Leg Balance",
      category: "vitals",
    },
    instructions: [
      "Stand on one leg, eyes open, arms free. Time how long you hold it (stop at a stumble or 45 seconds).",
      "Enter your best time in seconds.",
    ],
    min: 0,
    max: 45,
  },
  {
    key: "tug",
    label: "Timed up-and-go",
    tier: "norms",
    domain: "mobility",
    ageBand: "senior",
    unit: "seconds",
    inputKind: "seconds",
    normsMarker: "Timed Up-and-Go",
    store: { kind: "vital", canonical: "Timed Up-and-Go", category: "vitals" },
    lowerIsBetter: true,
    citation: "Rikli & Jones Senior Fitness Test (8-foot up-and-go).",
    instructions: [
      "Sit in a chair. On 'go', stand, walk 8 feet (2.4 m) around a cone, and sit back down.",
      "Enter the time in seconds (faster is fitter).",
    ],
    min: 1,
    max: 60,
  },
  {
    key: "fourstage",
    label: "4-stage balance test",
    tier: "evidence",
    domain: "balance",
    ageBand: "senior",
    unit: "stages",
    inputKind: "number",
    store: {
      kind: "vital",
      canonical: "4-Stage Balance Test",
      category: "vitals",
    },
    citation: "CDC STEADI 4-stage balance test.",
    interpretation:
      "Not holding the full tandem stand for 10 seconds indicates increased fall risk.",
    instructions: [
      "Hold each stance 10 s: feet together, instep-to-big-toe, heel-to-toe (tandem), then one leg.",
      "Enter how many of the 4 stages you held for a full 10 seconds (0-4).",
    ],
    min: 0,
    max: 4,
  },
  {
    key: "sitreach",
    label: "Sit-and-reach",
    tier: "norms",
    domain: "flexibility",
    ageBand: "both",
    unit: "cm",
    inputKind: "number",
    normsMarker: "Sit-and-Reach",
    store: { kind: "vital", canonical: "Sit-and-Reach", category: "vitals" },
    citation: "ACSM / YMCA sit-and-reach norms.",
    instructions: [
      "Sit with legs straight, feet against a box marked 26 cm at the footline. Reach forward slowly as far as you can.",
      "Enter the distance reached in centimeters.",
    ],
    min: 0,
    max: 60,
  },
  {
    key: "srt",
    label: "Sitting-rising test",
    tier: "evidence",
    domain: "mobility",
    ageBand: "both",
    unit: "score",
    inputKind: "number",
    store: {
      kind: "vital",
      canonical: "Sitting-Rising Test",
      category: "vitals",
    },
    citation: "Brito/Araújo, Eur J Prev Cardiol 2014.",
    interpretation:
      "A composite score below 8 (of 10) is linked to higher mortality.",
    instructions: [
      "From standing, lower to sitting cross-legged on the floor, then rise — using as little support as possible.",
      "Start at 10; subtract 1 for each hand/knee/forearm used, 0.5 for a wobble. Enter the 0-10 score.",
    ],
    min: 0,
    max: 10,
  },
  {
    key: "deadhang",
    label: "Dead hang",
    tier: "self-norm",
    domain: "strength",
    ageBand: "adult",
    unit: "seconds",
    inputKind: "seconds",
    holdNorm: "deadhang",
    store: { kind: "set", lift: "Dead Hang", timed: true },
    interpretation:
      "Placed on a rough population guide (weak/fair/good/excellent) — no validated norms — and tracked against your own prior checks.",
    instructions: [
      "Hang from a bar with a full grip, arms straight. Time how long you hold before your grip fails.",
      "Enter your best time in seconds.",
    ],
    equipment: {
      needs: "pull-up bar",
      substitute:
        "No bar? Substitute a farmer-carry hold and note it — still tracked vs your own prior.",
    },
    min: 0,
    max: 600,
  },
  {
    key: "plank",
    label: "Plank hold",
    tier: "self-norm",
    domain: "strength",
    ageBand: "adult",
    unit: "seconds",
    inputKind: "seconds",
    holdNorm: "plank",
    store: { kind: "set", lift: "Plank", timed: true },
    interpretation:
      "Placed on a rough population guide (weak/fair/good/excellent) — no validated norms — and tracked against your own prior checks.",
    instructions: [
      "Hold a forearm plank with a straight line from head to heels. Time until form breaks.",
      "Enter your best time in seconds.",
    ],
    min: 0,
    max: 900,
  },
  {
    key: "bodyfat",
    label: "Body fat %",
    tier: "body",
    domain: "body",
    ageBand: "both",
    unit: "%",
    inputKind: "number",
    store: { kind: "body", column: "body_fat_pct" },
    lowerIsBetter: true,
    instructions: [
      "Enter your body fat percentage from a scale, caliper, or DEXA if you have one.",
    ],
    min: 2,
    max: 60,
  },
  {
    key: "restinghr",
    label: "Resting heart rate",
    tier: "body",
    domain: "body",
    ageBand: "both",
    unit: "bpm",
    inputKind: "number",
    store: { kind: "body", column: "resting_hr" },
    lowerIsBetter: true,
    instructions: [
      "Measure your heart rate at rest (ideally on waking, before getting up). Enter beats per minute.",
    ],
    min: 25,
    max: 150,
  },
];

// The core barbell lifts the big-lift (`standard`-tier) test offers — all carry strength
// standards. ONE source of truth so the entry form, the auto-count read-back (#1129, which
// scans these for a recent heavy set), and the tests can't drift.
export const BIG_LIFT_OPTIONS = [
  "Back Squat",
  "Front Squat",
  "Bench Press",
  "Deadlift",
  "Overhead Press",
] as const;

// Fast lookup by key.
const BY_KEY = new Map(FITNESS_BATTERY.map((t) => [t.key, t]));

export function fitnessTest(key: string): FitnessTestDef | undefined {
  return BY_KEY.get(key);
}

// The age threshold at which the battery swaps to the senior (Senior Fitness Test /
// STEADI) variant. Re-exported from the one age model so it can't drift.
export const SENIOR_BATTERY_MIN_AGE = OLDER_ADULT_MIN_AGE;

// Whether a subject of this age gets the senior battery variant. Unknown age → adult (the
// default variant); the whole check is adult-gated elsewhere (norms return null for
// minors), so this only chooses between the two ADULT-and-up variants.
export function usesSeniorBattery(age: number | null | undefined): boolean {
  return age != null && Number.isFinite(age) && age >= SENIOR_BATTERY_MIN_AGE;
}

// The battery variant for a subject's age: `both` tests plus the adult-only OR senior-
// only swaps. Never hands a senior the Cooper run / dead hang, nor an adult the SFT-only
// items. Order is preserved from FITNESS_BATTERY.
export function batteryForAge(
  age: number | null | undefined
): FitnessTestDef[] {
  const senior = usesSeniorBattery(age);
  const want: FitnessAgeBand = senior ? "senior" : "adult";
  return FITNESS_BATTERY.filter(
    (t) => t.ageBand === "both" || t.ageBand === want
  );
}
