// Load .env / .env.local so scripts respect the same config as the app.
// (The Next.js runtime does this automatically; tsx-run scripts do not.)
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, today } from "../lib/db";
import { shiftDateStr } from "../lib/date";
import { reconcileFlags } from "../lib/queries";
import { providerDedupKey } from "../lib/providers";
import {
  diffSituations,
  serializeSituationEvents,
} from "../lib/trend-annotations";

// The seed populates the bootstrap profile. Owned-table
// rows are born NOT NULL on a fresh DB, so every insert carries profile_id = 1.
const SEED_PROFILE_ID = 1;

// Pure calendar-string arithmetic off the app's "today", so seeded dates never
// land on tomorrow from mixing local Date math with UTC formatting.
function daysAgo(n: number): string {
  return shiftDateStr(today(SEED_PROFILE_ID), -n);
}

// The seed targets profile 1 specifically. On a fresh DB bootstrapAuth() creates
// it; if it's missing here, an admin deleted it (profile deletion). Rather than
// resurrect a deliberately-removed profile, fail with guidance.
const profileOne = db.prepare("SELECT 1 FROM profiles WHERE id = 1").get();
if (!profileOne) {
  console.log(
    "Profile 1 does not exist — the seed targets profile 1. Delete data/allos.db to start fresh, or add a profile in Settings → Family."
  );
  process.exit(1);
}

const count = db
  .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
  .get(SEED_PROFILE_ID) as {
  c: number;
};
if (count.c > 0) {
  console.log(
    "Database already has data — skipping seed. (Delete data/allos.db to reseed.)"
  );
  process.exit(0);
}

const insertActivity = db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, notes, duration_min, distance_km, intensity)
   VALUES (1,?,?,?,?,?,?,?)`
);
const insertSet = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps) VALUES (?,?,?,?,?)`
);
// Timed (isometric hold) sets store seconds instead of reps.
const insertSetTimed = db.prepare(
  `INSERT INTO exercise_sets (activity_id, exercise, set_number, duration_sec) VALUES (?,?,?,?)`
);

// A few months of a consistent 3x/week push/pull/legs routine with progressive
// overload. ~16 weeks, one Push / Pull / Legs session per week on a Mon/Wed/Fri
// cadence, weights creeping up week over week. Exercise names match the catalog
// (incl. equipment variants) so muscle tags and strength trends resolve.
const PPL_WEEKS = 16;

// [exercise, base weight (kg), reps per set, kg added per week]. Bodyweight
// lifts use base 0.
type LiftPlan = [string, number, number[], number];
const PUSH: LiftPlan[] = [
  ["Barbell Bench Press", 60, [8, 8, 8], 1.0],
  ["Barbell Overhead Press", 38, [8, 8, 7], 0.5],
  ["Incline Bench Press", 45, [10, 10, 9], 0.75],
  ["Dumbbell Lateral Raise", 10, [15, 15, 15], 0.25],
  ["Tricep Pushdown", 25, [12, 12, 12], 0.5],
];
const PULL: LiftPlan[] = [
  ["Deadlift", 110, [5, 5, 5], 1.5],
  ["Barbell Row", 55, [8, 8, 8], 0.75],
  ["Pull Up", 0, [8, 8, 7], 0],
  ["Dumbbell Curl", 12, [12, 11, 10], 0.25],
  ["Face Pull", 20, [15, 15, 15], 0.5],
];
const LEGS: LiftPlan[] = [
  ["Back Squat", 80, [5, 5, 5], 1.5],
  ["Romanian Deadlift", 70, [8, 8, 8], 1.0],
  ["Leg Press", 140, [10, 10, 10], 2.0],
  ["Leg Curl", 35, [12, 12, 12], 0.5],
  ["Calf Raise", 50, [15, 15, 15], 1.0],
];
const PPL_DAYS: { title: string; plan: LiftPlan[]; offset: number }[] = [
  { title: "Push day", plan: PUSH, offset: 5 }, // ~Mon
  { title: "Pull day", plan: PULL, offset: 3 }, // ~Wed
  { title: "Leg day", plan: LEGS, offset: 1 }, //  ~Fri
];

const round05 = (n: number) => Math.round(n * 2) / 2;

// Oldest week first so progression reads forward in time.
for (let w = PPL_WEEKS - 1; w >= 0; w--) {
  const weeksDone = PPL_WEEKS - 1 - w;
  for (const { title, plan, offset } of PPL_DAYS) {
    const id = Number(
      insertActivity.run(
        daysAgo(w * 7 + offset),
        "strength",
        title,
        null,
        60,
        null,
        "hard"
      ).lastInsertRowid
    );
    for (const [exercise, base, reps, perWeek] of plan) {
      const weight = base > 0 ? round05(base + weeksDone * perWeek) : null;
      reps.forEach((r, i) => insertSet.run(id, exercise, i + 1, weight, r));
    }
  }
}

// A handful of cardio + sport sessions for variety alongside the lifting. Each
// carries a structured component with the canonical activity name (the title is
// freeform), so repeated activities — e.g. several "Running" sessions logged
// under different titles — combine in the Training page's analytics.
const insertActivityC = db.prepare(
  `INSERT INTO activities (profile_id, date, type, title, notes, duration_min, distance_km, intensity, components)
   VALUES (1,?,?,?,?,?,?,?,?)`
);
function logEffort(
  ago: number,
  type: "cardio" | "sport",
  name: string,
  title: string,
  notes: string | null,
  durationMin: number,
  distanceKm: number | null,
  intensity: string
) {
  const components = JSON.stringify([
    { name, type, distance_km: distanceKm, duration_min: durationMin },
  ]);
  insertActivityC.run(
    daysAgo(ago),
    type,
    title,
    notes,
    durationMin,
    distanceKm,
    intensity,
    components
  );
}
logEffort(
  18,
  "cardio",
  "Running",
  "Morning run",
  "Felt great",
  32,
  5.2,
  "moderate"
);
logEffort(14, "cardio", "Cycling", "Zone 2 bike", null, 45, 18, "easy");
logEffort(9, "cardio", "Running", "Intervals", "8x400m", 28, 4.0, "hard");
logEffort(
  5,
  "sport",
  "Tennis",
  "Tennis singles",
  "Won 2 sets",
  90,
  null,
  "hard"
);
logEffort(2, "cardio", "Running", "5k run", "New tempo PB", 24, 5.0, "hard");
logEffort(
  1,
  "sport",
  "Basketball",
  "Basketball pickup",
  null,
  75,
  null,
  "moderate"
);

// A Strava-imported ride (issue #11): provenance chip reads "Strava". Carries a
// source + external_id like the real Strava pull, so the Journal's provenance
// surface has an integration-sourced row to render (the manual seed rows all
// read "Manual"). Richer per-activity metrics stay NULL — the chip is the point.
const insertActivityStrava = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, notes, duration_min, distance_km, intensity,
      components, source, external_id)
   VALUES (1,?,?,?,?,?,?,?,?,?,?)`
);
insertActivityStrava.run(
  daysAgo(3),
  "cardio",
  "Strava morning ride",
  null,
  62,
  24.5,
  "moderate",
  JSON.stringify([
    { name: "Cycling", type: "cardio", distance_km: 24.5, duration_min: 62 },
  ]),
  "strava",
  "strava:seed-ride-1"
);

// A recent core session with isometric holds, so timed-hold goals have data.
const coreId = Number(
  insertActivity.run(
    daysAgo(4),
    "strength",
    "Core day",
    null,
    20,
    null,
    "moderate"
  ).lastInsertRowid
);
[90, 100, 110].forEach((sec, i) =>
  insertSetTimed.run(coreId, "Plank", i + 1, sec)
);

// Body metrics trending down over the same few months (about one per week).
const wi = db.prepare(
  `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr, notes) VALUES (1,?,?,?,?,?)`
);
for (let w = PPL_WEEKS - 1; w >= 0; w--) {
  const i = PPL_WEEKS - 1 - w; // 0 = oldest
  const weight = round05(83 - i * 0.18 + (i % 3 === 0 ? 0.3 : 0)); // gentle drift with wobble
  const bodyFat = Math.round((19 - i * 0.12) * 10) / 10;
  wi.run(daysAgo(w * 7 + 1), weight, bodyFat, 58 - Math.floor(i / 4), null);
}

// Goals — a mix of freeform (manual progress) and exercise-linked goals whose
// progress is auto-derived from the logged sets above.
const goal = db.prepare(
  `INSERT INTO goals (profile_id, title, description, category, target_value, current_value, unit, target_date, status)
   VALUES (1,?,?,?,?,?,?,?,?)`
);
// Freeform goals (manual target/current) — unchanged behavior.
// Body-metric goals: auto-tracked from body metrics, progress baseline → target
// (one per metric — bodyweight, body fat, resting HR — all reduction goals).
const bodyGoal = db.prepare(
  `INSERT INTO goals (profile_id, title, category, target_value, body_metric, baseline_value, target_date, status)
   VALUES (1,?,?,?,?,?,?,'active')`
);
bodyGoal.run("Cut to 78 kg", "body", 78, "weight", 86, daysAgo(-60));
bodyGoal.run("Drop to 15% body fat", "body", 15, "body_fat", 19, daysAgo(-90));
bodyGoal.run("Resting HR under 52", "body", 52, "resting_hr", 60, daysAgo(-90));
goal.run(
  "Run 10k under 50 min",
  "Improve aerobic base",
  "cardio",
  10,
  5,
  "km",
  daysAgo(-120),
  "active"
);

// Exercise-linked goals: progress derives from sets (weight / reps / sets×reps / hold).
const exGoal = db.prepare(
  `INSERT INTO goals (profile_id, title, status, exercise, metric,
       target_weight_kg, target_reps, target_sets, target_duration_sec, target_date)
   VALUES (1, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
);
// weight: top bench ~75kg vs 100 → ~75%
exGoal.run(
  "Bench Press 100 kg",
  "Barbell Bench Press",
  "weight",
  100,
  null,
  null,
  null,
  daysAgo(-90)
);
// weight: top squat ~102kg vs 140 → ~73%
exGoal.run(
  "Back Squat 140 kg",
  "Back Squat",
  "weight",
  140,
  null,
  null,
  null,
  daysAgo(-120)
);
// sets: deadlift logged 3×5 @ ~132kg, target 3×5 @ 120 → complete
exGoal.run(
  "Deadlift 3×5 @ 120 kg",
  "Deadlift",
  "sets",
  120,
  5,
  3,
  null,
  daysAgo(-60)
);
// reps: pull-ups logged up to 8 vs 10 → 80%
exGoal.run(
  "10 strict pull-ups",
  "Pull Up",
  "reps",
  null,
  10,
  null,
  null,
  daysAgo(-90)
);
// hold: best plank 1:50 vs 2:30 → ~73%
exGoal.run(
  "Plank 2:30 hold",
  "Plank",
  "hold",
  null,
  null,
  null,
  150,
  daysAgo(-45)
);

// Weekly frequency targets ("hit X at least N×/week"). Counts distinct training
// days over the rolling 7 days, so the recent PPL + cardio sessions populate them.
const freq = db.prepare(
  `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week) VALUES (1,?,?,?)`
);
freq.run("group", "Upper", 2); // push + pull days → met
freq.run("group", "Lower", 1); // leg day → met
freq.run("region", "Chest", 2); // one push day → partial
freq.run("type", "cardio", 2); // one recent run → partial

// Profile demographics: a ~40-year-old male. Sex is set
// BEFORE the medical records below so reconcileFlags picks the sex-specific
// reference/optimal bands (hormones, ferritin, …); birthdate (also set with the
// immunizations further down) makes the immunization schedule age-aware. No
// reproductive_status for a male profile.
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'sex', 'male')
   ON CONFLICT(profile_id, key) DO NOTHING`
).run();

// Medical records — comprehensive biomarker panels measured over the past ~3
// years. Every canonical_name matches a canonical_biomarkers row that HAS an
// optimal range, so trends render and the optimal-band ("non-optimal") flagging
// is demoable. Flags are derived from the canonical ranges via reconcileFlags
// below (not hand-set), so high/low/non-optimal stay consistent with the data.
type MedCategory = "lab" | "biomarker" | "vitals" | "scan";
interface Panel {
  category: MedCategory;
  name: string; // display name (also the canonical name unless noted)
  canonical: string; // must match a canonical_biomarkers entry
  unit: string | null;
  ref: string | null; // reference range, as shown on a lab report
  values: number[]; // one per LAB_DATES entry, oldest → newest
}

// Six lab draws spanning ~3 years, oldest first.
const LAB_DATES = [1080, 870, 660, 450, 240, 30];

// The lab each draw was sent to, parallel to LAB_DATES. Because every reading of
// a biomarker inherits its draw's lab, the same biomarker shows varying panels
// over time — mirroring a patient whose bloodwork moved between providers. Only
// applied to lab/biomarker draws; vitals and scans aren't lab work.
const LAB_PANELS = [
  "Quest Diagnostics",
  "LabCorp",
  "Quest Diagnostics",
  "BioReference",
  "LabCorp",
  "Quest Diagnostics",
];

function panelFor(category: MedCategory, i: number): string | null {
  if (category === "lab" || category === "biomarker") return LAB_PANELS[i];
  if (category === "vitals") return "Home Monitor";
  return null; // scans carry no panel
}

const PANELS: Panel[] = [
  // Lipids — steadily improving on diet + statin.
  {
    category: "lab",
    name: "Total Cholesterol",
    canonical: "Total Cholesterol",
    unit: "mg/dL",
    ref: "<200",
    values: [205, 198, 190, 184, 176, 171],
  },
  {
    category: "lab",
    name: "LDL Cholesterol",
    canonical: "LDL Cholesterol",
    unit: "mg/dL",
    ref: "<100",
    values: [131, 121, 110, 95, 80, 68],
  },
  {
    category: "lab",
    name: "HDL Cholesterol",
    canonical: "HDL Cholesterol",
    unit: "mg/dL",
    ref: ">40",
    values: [47, 50, 53, 56, 59, 62],
  },
  {
    category: "lab",
    name: "Triglycerides",
    canonical: "Triglycerides",
    unit: "mg/dL",
    ref: "<150",
    values: [145, 122, 105, 92, 80, 71],
  },
  {
    category: "lab",
    name: "ApoB",
    canonical: "ApoB",
    unit: "mg/dL",
    ref: "<90",
    values: [101, 93, 85, 76, 66, 58],
  },
  {
    category: "lab",
    name: "Lipoprotein(a)",
    canonical: "Lipoprotein(a)",
    unit: "nmol/L",
    ref: "<75",
    values: [46, 48, 45, 47, 46, 45],
  },
  // Metabolic — improving insulin sensitivity.
  {
    category: "lab",
    name: "Glucose, Fasting",
    canonical: "Glucose",
    unit: "mg/dL",
    ref: "65-99",
    values: [96, 93, 90, 87, 84, 82],
  },
  {
    category: "lab",
    name: "Hemoglobin A1c",
    canonical: "Hemoglobin A1c",
    unit: "%",
    ref: "<5.7",
    values: [5.6, 5.5, 5.4, 5.3, 5.2, 5.1],
  },
  {
    category: "lab",
    name: "Insulin, Fasting",
    canonical: "Insulin",
    unit: "uIU/mL",
    ref: "<18.4",
    values: [9.5, 8.2, 7.1, 6.0, 5.2, 4.6],
  },
  {
    category: "lab",
    name: "HOMA-IR",
    canonical: "HOMA-IR",
    unit: "index",
    ref: "<2.0",
    values: [2.1, 1.8, 1.5, 1.3, 1.1, 0.9],
  },
  // Inflammation / liver.
  {
    category: "biomarker",
    name: "hs-CRP",
    canonical: "hs-CRP",
    unit: "mg/L",
    ref: "<3.0",
    values: [1.4, 1.1, 0.9, 0.8, 0.6, 0.5],
  },
  {
    category: "lab",
    name: "ALT",
    canonical: "ALT",
    unit: "U/L",
    ref: "<44",
    values: [31, 28, 26, 24, 22, 20],
  },
  {
    category: "lab",
    name: "GGT",
    canonical: "GGT",
    unit: "U/L",
    ref: "<50",
    values: [33, 30, 27, 24, 22, 20],
  },
  // Kidney — creatinine drives the derived eGFR virtual biomarker (issue #40),
  // computed at read time (CKD-EPI 2021) from these values + the profile's age/sex.
  {
    category: "lab",
    name: "Creatinine",
    canonical: "Creatinine",
    unit: "mg/dL",
    ref: "0.6-1.3",
    values: [1.02, 1.0, 0.99, 0.97, 0.96, 0.94],
  },
  {
    category: "biomarker",
    name: "Homocysteine",
    canonical: "Homocysteine",
    unit: "umol/L",
    ref: "<15",
    values: [11.2, 10.1, 9.2, 8.4, 7.8, 7.1],
  },
  // Kidney — a slow, sustained eGFR decline that STAYS in range (above the 60 CKD
  // floor) the whole time, so a single-value flag never fires — but the trajectory
  // rules (#41) do: the ~7 mL/min/1.73m²/yr fall beats the curated >5/yr velocity
  // threshold, and every reading sits below the 90 optimal floor (persistent
  // below-optimal). A worked example for the "Trajectory watch" card.
  {
    category: "lab",
    name: "eGFR",
    canonical: "eGFR",
    unit: "mL/min/1.73m2",
    ref: ">60",
    values: [88, 84, 80, 76, 72, 68],
  },
  // CBC + chemistry that (together with hs-CRP, Creatinine and Glucose above)
  // complete the nine-analyte panel driving the derived PhenoAge biological-age
  // index (Levine 2018, issue #157): Albumin, Alkaline Phosphatase, Lymphocyte %,
  // MCV, RDW and WBC. All six carry a value on every LAB_DATES draw, so an ADULT
  // profile (profile 1) gets a full PhenoAge series; the ~18-month-old (profile 2)
  // is correctly excluded by the deriver's adult age gate.
  {
    category: "lab",
    name: "Albumin",
    canonical: "Albumin",
    unit: "g/dL",
    ref: "3.5-5.0",
    values: [4.5, 4.6, 4.6, 4.7, 4.7, 4.8],
  },
  {
    category: "lab",
    name: "Alkaline Phosphatase",
    canonical: "Alkaline Phosphatase",
    unit: "U/L",
    ref: "40-129",
    values: [72, 70, 68, 66, 64, 62],
  },
  {
    category: "lab",
    name: "Lymphocytes",
    canonical: "Lymphocytes",
    unit: "%",
    ref: "20-40",
    values: [32, 33, 34, 34, 35, 36],
  },
  {
    category: "lab",
    name: "MCV",
    canonical: "MCV",
    unit: "fL",
    ref: "80-100",
    values: [89, 89, 90, 90, 91, 91],
  },
  {
    category: "lab",
    name: "RDW",
    canonical: "RDW",
    unit: "%",
    ref: "11.5-14.5",
    values: [13.4, 13.2, 13.1, 13.0, 12.9, 12.8],
  },
  {
    category: "lab",
    name: "White Blood Cell Count",
    canonical: "White Blood Cell Count",
    unit: "10^3/uL",
    ref: "3.4-10.8",
    values: [6.2, 6.0, 5.8, 5.6, 5.5, 5.4],
  },
  // Thyroid.
  {
    category: "lab",
    name: "TSH",
    canonical: "TSH",
    unit: "uIU/mL",
    ref: "0.4-4.5",
    values: [2.8, 2.5, 2.2, 2.0, 1.8, 1.7],
  },
  {
    category: "lab",
    name: "Free T3",
    canonical: "Free T3",
    unit: "pg/mL",
    ref: "2.3-4.2",
    values: [3.0, 3.1, 3.2, 3.3, 3.4, 3.5],
  },
  // Vitamins / minerals — Vitamin D climbs from deficient into the optimal band
  // with supplementation (replaces the old single Vitamin D reading).
  {
    category: "lab",
    name: "Vitamin D, 25-Hydroxy",
    canonical: "Vitamin D, 25-Hydroxy",
    unit: "ng/mL",
    ref: "30-100",
    values: [22, 29, 35, 43, 51, 55],
  },
  {
    category: "lab",
    name: "Vitamin B12",
    canonical: "Vitamin B12",
    unit: "pg/mL",
    ref: "200-1100",
    values: [420, 485, 550, 600, 640, 615],
  },
  {
    category: "lab",
    name: "Magnesium, RBC",
    canonical: "Magnesium, RBC",
    unit: "mg/dL",
    ref: "4.0-6.4",
    values: [4.6, 4.9, 5.2, 5.4, 5.6, 5.8],
  },
  {
    category: "biomarker",
    name: "Omega-6/Omega-3 Ratio",
    canonical: "Omega-6/Omega-3 Ratio",
    unit: "ratio",
    ref: "3.7-14.4",
    values: [9.2, 7.4, 5.6, 4.6, 4.0, 3.4],
  },
  // Vitals.
  {
    category: "vitals",
    name: "Blood Pressure Systolic",
    canonical: "Blood Pressure Systolic",
    unit: "mmHg",
    ref: "90-120",
    values: [123, 121, 118, 116, 114, 112],
  },
  {
    category: "vitals",
    name: "Blood Pressure Diastolic",
    canonical: "Blood Pressure Diastolic",
    unit: "mmHg",
    ref: "60-80",
    values: [81, 79, 77, 76, 74, 72],
  },
  {
    category: "vitals",
    name: "Resting Heart Rate",
    canonical: "Resting Heart Rate",
    unit: "bpm",
    ref: "60-100",
    values: [61, 59, 57, 55, 54, 52],
  },
  // Body composition / fitness (from periodic DEXA + VO2 max tests).
  {
    category: "scan",
    name: "Body Fat Percentage",
    canonical: "Body Fat Percentage",
    unit: "%",
    ref: null,
    values: [22.5, 20.8, 19.0, 17.5, 16.2, 15.0],
  },
  {
    category: "scan",
    name: "VO2 Max",
    canonical: "VO2 Max",
    unit: "mL/kg/min",
    ref: null,
    values: [42, 44, 46, 48, 50, 52],
  },
  // Male reproductive hormones — flags resolve against the male
  // sex-specific bands set above. Total testosterone climbs from below the male
  // optimal band (<500) into it; free testosterone + estradiol stay mid-range.
  {
    category: "lab",
    name: "Testosterone, Total",
    canonical: "Testosterone, Total",
    unit: "ng/dL",
    ref: "264-916",
    values: [430, 470, 510, 560, 600, 640], // first draws non-optimal-low (<500), then optimal
  },
  {
    category: "lab",
    name: "Testosterone, Free",
    canonical: "Testosterone, Free",
    unit: "pg/mL",
    ref: "35-155",
    values: [58, 62, 70, 78, 85, 92],
  },
  {
    category: "lab",
    name: "Estradiol",
    canonical: "Estradiol",
    unit: "pg/mL",
    ref: "10-40",
    values: [28, 31, 34, 30, 36, 33],
  },
  // Not retested recently: these panels supply only the oldest few draws, so
  // their latest reading maps to an early LAB_DATES slot (>1 year ago) and the
  // biomarkers table flags them stale (⏳). A short trend keeps grouping demoable.
  {
    category: "lab",
    name: "Ferritin",
    canonical: "Ferritin",
    unit: "ng/mL",
    ref: "30-400",
    values: [58, 72, 90], // newest maps to daysAgo(660) ≈ 1.8y ago → stale
  },
  {
    category: "lab",
    name: "Uric Acid",
    canonical: "Uric Acid",
    unit: "mg/dL",
    ref: "3.5-7.2",
    values: [6.9, 6.4], // newest maps to daysAgo(870) ≈ 2.4y ago → stale
  },
  {
    category: "lab",
    name: "Free T4",
    canonical: "Free T4",
    unit: "ng/dL",
    ref: "0.8-1.8",
    values: [1.1, 1.2, 1.2, 1.3], // newest maps to daysAgo(450) ≈ 1.2y ago → stale
  },
];

const insMed = db.prepare(
  `INSERT INTO medical_records
     (profile_id, date, category, name, value, unit, reference_range, value_num, canonical_name, panel)
   VALUES (1,?,?,?,?,?,?,?,?,?)`
);
const medIds: number[] = [];
for (const p of PANELS) {
  p.values.forEach((v, i) => {
    const id = insMed.run(
      daysAgo(LAB_DATES[i]),
      p.category,
      p.name,
      String(v),
      p.unit,
      p.ref,
      v,
      p.canonical,
      panelFor(p.category, i)
    ).lastInsertRowid;
    medIds.push(Number(id));
  });
}
// Derive clinical (high/low) and non-optimal flags from the canonical reference
// + optimal bands, so seeded readings flag exactly like real imported ones.
reconcileFlags(SEED_PROFILE_ID, medIds);

// Non-biomarker records (no optimal range; kept for category variety).
const med = db.prepare(
  `INSERT INTO medical_records (profile_id, date, category, name, value, unit, reference_range, notes) VALUES (1,?,?,?,?,?,?,?)`
);
med.run(
  daysAgo(60),
  "genomics",
  "APOE genotype",
  "e3/e3",
  null,
  null,
  "Neutral risk"
);
med.run(
  daysAgo(60),
  "genomics",
  "MTHFR C677T",
  "Heterozygous",
  null,
  null,
  "Consider methylated folate"
);
med.run(
  daysAgo(45),
  "prescription",
  "Atorvastatin",
  "10mg",
  "daily",
  null,
  "Preventive"
);

// Immunizations — an adult profile (~40y). A birthdate makes the schedule's
// age-based recommendations meaningful; childhood series are represented, plus
// a recent Tdap booster and a seasonal flu, and two immunity titers so the
// schedule grid, status buckets, and titer aggregation all render populated.
db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'birthdate', ?)
   ON CONFLICT(profile_id, key) DO NOTHING`
).run("1986-04-12");

const imm = db.prepare(
  `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, notes, source)
   VALUES (1,?,?,?,?,NULL)`
);
imm.run("2011-06-15", "mmr", "Dose 2 (records)", null);
imm.run("2018-09-01", "tdap", "Booster", null);
// Last season's flu shot only — an annual vaccine now ~13 months old, so it reads
// as overdue on the schedule and surfaces as an Upcoming immunization signal.
imm.run(daysAgo(400), "influenza", "2024–25 season", null);

// Immunity titers stored as biomarkers (matched by name, no canonical needed):
// one numeric anti-HBs above the immune threshold, one qualitative Measles IgG.
med.run(
  daysAgo(30),
  "lab",
  "Hepatitis B Surface Antibody",
  "45",
  "mIU/mL",
  ">=10",
  "Immune"
);
med.run(daysAgo(30), "lab", "Measles IgG", "Immune", null, null, null);

// Supplements — scheduling context, priority, brand/product, stacks, food
// timing, split dosing, a situational example, and an interaction pair so every
// feature is demoable.
const sup = db.prepare(
  `INSERT INTO intake_items
     (profile_id, name, notes, condition, priority, brand, product, situation, stack)
   VALUES (1,?,?,?,?,?,?,?,?)`
);
const dose = db.prepare(
  `INSERT INTO intake_item_doses (supplement_id, amount, time_of_day, food_timing, sort)
   VALUES (?,?,?,?,?)`
);
type DoseSeed = { amount: string | null; time: string | null; food: string };
function addSupp(
  s: {
    name: string;
    notes?: string | null;
    condition?: string;
    priority?: string;
    brand?: string | null;
    product?: string | null;
    situation?: string | null;
    stack?: string | null;
  },
  doses: DoseSeed[]
): number {
  const id = Number(
    sup.run(
      s.name,
      s.notes ?? null,
      s.condition ?? "daily",
      s.priority ?? "high",
      s.brand ?? null,
      s.product ?? null,
      s.situation ?? null,
      s.stack ?? null
    ).lastInsertRowid
  );
  doses.forEach((d, i) => dose.run(id, d.amount, d.time, d.food, i));
  return id;
}

// Fat-soluble, lab-confirmed deficiency → mandatory; stacked with K2.
addSupp(
  {
    name: "Vitamin D3",
    priority: "mandatory",
    brand: "Thorne",
    product: "Vitamin D/K2",
    stack: "D3 + K2",
    notes: "With breakfast",
  },
  [{ amount: "2000 IU", time: "Morning", food: "with_fat" }]
);
addSupp({ name: "Vitamin K2", priority: "high", stack: "D3 + K2" }, [
  { amount: "100 mcg", time: "Morning", food: "with_fat" },
]);
addSupp(
  { name: "Creatine Monohydrate", condition: "post_workout", priority: "low" },
  [{ amount: "5 g", time: "Anytime", food: "any" }]
);
// Split dose across two fat-containing meals.
addSupp({ name: "Omega-3", priority: "high", brand: "Nordic Naturals" }, [
  { amount: "600 mg", time: "Midday", food: "with_fat" },
  { amount: "600 mg", time: "Evening", food: "with_fat" },
]);
addSupp({ name: "Magnesium Glycinate", priority: "high", notes: "Sleep" }, [
  { amount: "400 mg", time: "Before sleep", food: "any" },
]);
addSupp(
  {
    name: "Whey Protein",
    condition: "post_workout",
    priority: "low",
    brand: "Optimum Nutrition",
  },
  [{ amount: "30 g", time: "Anytime", food: "any" }]
);
// Before-meal example.
addSupp(
  { name: "Plant Sterols", priority: "low", notes: "Cholesterol support" },
  [{ amount: "2 g", time: "Evening", food: "before_meal" }]
);
// A "keep apart" pair: calcium blocks iron absorption.
const calId = addSupp({ name: "Calcium", priority: "low" }, [
  { amount: "500 mg", time: "Midday", food: "with_food" },
]);
const ironId = addSupp(
  { name: "Iron", priority: "low", notes: "Empty stomach for absorption" },
  [{ amount: "18 mg", time: "Morning", food: "empty_stomach" }]
);
// Situational: only surfaces while "Illness" is active.
addSupp(
  {
    name: "Zinc",
    condition: "situational",
    priority: "low",
    situation: "Illness",
    notes: "Immune support",
  },
  [{ amount: "15 mg", time: "Evening", food: "with_food" }]
);

db.prepare(
  `INSERT OR IGNORE INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
).run(
  Math.min(calId, ironId),
  Math.max(calId, ironId),
  "separate",
  "Calcium blocks iron absorption"
);

// Medications — a current med with a prior (stopped) course to demo the
// course history + side effects, plus a fully discontinued med for the Past list.
const medIns = db.prepare(
  `INSERT INTO intake_items
     (profile_id, name, notes, condition, priority, kind, prescriber, active)
   VALUES (1,?,?,?,?, 'medication', ?, ?)`
);
const courseIns = db.prepare(
  `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?,?,?,?,?)`
);
const sideEffectIns = db.prepare(
  `INSERT INTO intake_item_side_effects
     (item_id, course_id, effect, severity, noted_on, resolved)
   VALUES (?,?,?,?,?,?)`
);
const medDose = db.prepare(
  `INSERT INTO intake_item_doses (supplement_id, amount, time_of_day, food_timing, sort)
   VALUES (?,?,?,?,?)`
);

// Sertraline: stopped once (side effect) then restarted — shows in Current with a
// two-course history and a resolved side effect linked to the first course.
const sertId = Number(
  medIns.run("Sertraline", "SSRI", "daily", "high", "Patel", 1).lastInsertRowid
);
medDose.run(sertId, "50 mg", "Morning", "with_food", 0);
const sertCourse1 = Number(
  courseIns.run(
    sertId,
    daysAgo(120),
    daysAgo(45),
    "side_effect",
    "Nausea in the first weeks"
  ).lastInsertRowid
);
courseIns.run(sertId, daysAgo(20), null, null, "Restarted at a lower dose");
sideEffectIns.run(sertId, sertCourse1, "Nausea", "moderate", daysAgo(110), 1);

// Amoxicillin: a completed antibiotic course — shows in Past / discontinued.
const amoxId = Number(
  medIns.run("Amoxicillin", "Antibiotic", "daily", "high", "Patel", 0)
    .lastInsertRowid
);
medDose.run(amoxId, "500 mg", "Morning", "with_food", 0);
courseIns.run(
  amoxId,
  daysAgo(60),
  daysAgo(50),
  "completed_course",
  "10-day course"
);

// Log adherence per dose over the last week.
const allDoses = db
  .prepare("SELECT id, supplement_id FROM intake_item_doses")
  .all() as { id: number; supplement_id: number }[];
const supLog = db.prepare(
  `INSERT OR IGNORE INTO intake_item_logs (dose_id, supplement_id, date) VALUES (?,?,?)`
);
for (let d = 6; d >= 1; d--) {
  for (const dd of allDoses) {
    if (Math.random() > 0.2) supLog.run(dd.id, dd.supplement_id, daysAgo(d));
  }
}

// ── Providers (GLOBAL registry) ───────────────────────────────────────
// Not profile-scoped: appointments/encounters/immunizations link to these via a
// nullable provider_id. dedup_key is the pure global key so a later import won't
// coin a duplicate.
const provIns = db.prepare(
  `INSERT INTO providers (name, type, npi, identifier, phone, address, dedup_key)
   VALUES (?,?,?,?,?,?,?)`
);
function addProvider(
  name: string,
  type: "organization" | "individual",
  opts: {
    npi?: string | null;
    identifier?: string | null;
    phone?: string | null;
    address?: string | null;
  } = {}
): number {
  const dedup = providerDedupKey({
    name,
    type,
    npi: opts.npi ?? null,
    identifier: opts.identifier ?? null,
  });
  return Number(
    provIns.run(
      name,
      type,
      opts.npi ?? null,
      opts.identifier ?? null,
      opts.phone ?? null,
      opts.address ?? null,
      dedup
    ).lastInsertRowid
  );
}
const drPatel = addProvider("Dr. Anita Patel", "individual", {
  npi: "1234567890",
  phone: "(415) 555-0132",
});
const drLee = addProvider("Dr. Marcus Lee", "individual", {
  npi: "1234567891",
});
addProvider("Quest Diagnostics", "organization", { npi: "1234567893" });
const clinic = addProvider("Northside Family Medicine", "organization", {
  address: "120 Elm St, Springfield",
  phone: "(415) 555-0100",
});

// ── Appointments ──────────────────────────────────────────────────────
// One completed (history) plus scheduled rows spread so the Upcoming urgency
// bands each get a hit: a past-and-still-scheduled row → Overdue, one today, one
// this week, one further out → Later.
const apptIns = db.prepare(
  `INSERT INTO appointments (profile_id, scheduled_at, provider_id, title, location, notes, status)
   VALUES (1,?,?,?,?,?,?)`
);
apptIns.run(
  daysAgo(35),
  drPatel,
  "Annual physical",
  "Northside Family Medicine",
  "Fasting labs drawn",
  "completed"
);
apptIns.run(
  daysAgo(6),
  drLee,
  "Cardiology follow-up",
  "Heart Center",
  null,
  "scheduled"
); // past + scheduled → Overdue
apptIns.run(
  daysAgo(0),
  drPatel,
  "Lab results review",
  "Northside Family Medicine",
  null,
  "scheduled"
); // Today
apptIns.run(
  daysAgo(-4),
  drLee,
  "Echocardiogram",
  "Heart Center",
  "Bring insurance card",
  "scheduled"
); // This week
apptIns.run(
  daysAgo(-45),
  drPatel,
  "Physical exam",
  "Northside Family Medicine",
  null,
  "scheduled"
); // Later

// ── Conditions / problem list ─────────────────────────────────────────
const condIns = db.prepare(
  `INSERT INTO conditions (profile_id, name, code, code_system, status, onset_date, resolved_date, notes)
   VALUES (1,?,?,?,?,?,?,?)`
);
condIns.run(
  "Essential hypertension",
  "I10",
  "ICD-10",
  "active",
  "2019-03-01",
  null,
  "Diet + exercise managed"
);
condIns.run(
  "Hyperlipidemia",
  "E78.5",
  "ICD-10",
  "active",
  "2018-11-15",
  null,
  "On atorvastatin"
);
condIns.run(
  "Vitamin D deficiency",
  "E55.9",
  "ICD-10",
  "resolved",
  daysAgo(1080),
  daysAgo(200),
  "Resolved with supplementation"
); // coherent with the climbing Vitamin D panel

// ── Allergies ─────────────────────────────────────────────────────────
// The Amoxicillin course seeded above is DISCONTINUED (a past, inactive med), so a
// documented Penicillin allergy is coherent — discovered after the course, which is
// why it was stopped. The Penicillin row also anchors the #19 global-search e2e
// (Cmd-K "penicillin" must surface this allergy).
const allIns = db.prepare(
  `INSERT INTO allergies (profile_id, substance, reaction, severity, status, onset_date, notes)
   VALUES (1,?,?,?,?,?,?)`
);
allIns.run(
  "Penicillin",
  "Hives and swelling",
  "severe",
  "active",
  "2005-06-01",
  "Reaction to amoxicillin course; avoid all penicillins"
);
allIns.run("Peanuts", "Hives", "moderate", "active", "1998-01-01", null);
allIns.run(
  "Sulfa drugs",
  "Rash",
  "mild",
  "active",
  null,
  "Avoid sulfonamide antibiotics"
);
allIns.run(
  "Pollen",
  "Allergic rhinitis",
  "mild",
  "active",
  null,
  "Seasonal (spring)"
);

// ── Encounters / visit history ────────────────────────────────────────
const encIns = db.prepare(
  `INSERT INTO encounters (profile_id, date, end_date, type, class_code, reason, diagnoses, provider_id, location_provider_id, notes)
   VALUES (1,?,?,?,?,?,?,?,?,?)`
);
encIns.run(
  daysAgo(35),
  null,
  "Office Visit",
  "AMB",
  "Annual physical",
  "Essential hypertension; Hyperlipidemia",
  drPatel,
  clinic,
  null
);
encIns.run(
  daysAgo(400),
  null,
  "Office Visit",
  "AMB",
  "Cardiology consult",
  "Hyperlipidemia",
  drLee,
  null,
  "Referred for lipid management"
);

// ── Procedures / surgical history ────────────────────────────────────────────
const procIns = db.prepare(
  `INSERT INTO procedures (profile_id, name, code, code_system, date, provider_id, notes)
   VALUES (1,?,?,?,?,?,?)`
);
procIns.run(
  "Appendectomy",
  "44970",
  "CPT",
  "2005-06-12",
  null,
  "Laparoscopic, uncomplicated"
);
procIns.run(
  "Screening colonoscopy",
  "45378",
  "CPT",
  daysAgo(420),
  drLee,
  "No polyps; repeat in 10 years"
);

// ── Family history ───────────────────────────────────────────────────────────
const famIns = db.prepare(
  `INSERT INTO family_history (profile_id, relation, condition, code, code_system, onset_age, deceased, notes)
   VALUES (1,?,?,?,?,?,?,?)`
);
famIns.run("Father", "Type 2 diabetes", "44054006", "SNOMED CT", 55, 0, null);
famIns.run(
  "Father",
  "Coronary artery disease",
  "53741008",
  "SNOMED CT",
  62,
  1,
  "Fatal MI at 68"
);
famIns.run("Mother", "Breast cancer", "254837009", "SNOMED CT", 60, 0, null);
famIns.run("Sister", "Asthma", "195967001", "SNOMED CT", null, 0, null);

// ── Care plan / plan of treatment ────────────────────────────────────────────
// Planned / ordered future care (a health record's Plan of Treatment section).
// daysAgo(negative) yields a FUTURE date.
const carePlanIns = db.prepare(
  `INSERT INTO care_plan_items
     (profile_id, description, code, code_system, category, planned_date, status, provider_id, notes)
   VALUES (1,?,?,?,?,?,?,?,?)`
);
carePlanIns.run(
  "Follow-up lipid panel",
  "57698-3",
  "LOINC",
  "observation",
  daysAgo(-30),
  "planned",
  drLee,
  "Recheck after 3 months of statin therapy"
);
carePlanIns.run(
  "Repeat screening colonoscopy",
  "45378",
  "CPT",
  "procedure",
  daysAgo(-120),
  "planned",
  drLee,
  null
);
carePlanIns.run(
  "Nutrition counseling visit",
  "11816003",
  "SNOMED CT",
  "encounter",
  daysAgo(-14),
  "active",
  null,
  "Dietitian referral for weight management"
);

// ── Care goals / health goals from records ───────────────────────────────────
// Clinical goals recorded in the health record (Goals section). DISTINCT from the
// `goals` table (the user's own fitness/body goals).
const careGoalIns = db.prepare(
  `INSERT INTO care_goals
     (profile_id, description, code, code_system, target_date, status, notes)
   VALUES (1,?,?,?,?,?,?)`
);
careGoalIns.run(
  "HbA1c below 6.5%",
  "4548-4",
  "LOINC",
  daysAgo(-90),
  "active",
  "Set at last endocrinology visit"
);
careGoalIns.run(
  "Blood pressure under 130/80 mmHg",
  "85354-9",
  "LOINC",
  daysAgo(-60),
  "active",
  null
);
careGoalIns.run(
  "Reach target body weight 75 kg",
  null,
  null,
  daysAgo(-180),
  "proposed",
  "Gradual loss, ~0.5 kg/week"
);

// ── Active situations + change log (Trends Ph3 annotations) ──────────────────
// profile_settings stores only the CURRENT set; the dated start/stop log
// (situation_events) is what makes situations chartable. Build a small history so
// annotations have events, ending with "Illness" currently active (which also
// surfaces the situational Zinc supplement seeded above).
const situationTransitions: {
  date: string;
  before: string[];
  after: string[];
}[] = [
  { date: daysAgo(60), before: [], after: ["Illness"] },
  { date: daysAgo(52), before: ["Illness"], after: [] },
  { date: daysAgo(14), before: [], after: ["Travel"] },
  { date: daysAgo(9), before: ["Travel"], after: [] },
  { date: daysAgo(3), before: [], after: ["Illness"] },
];
const situationEvents = situationTransitions.flatMap((t) =>
  diffSituations(t.before, t.after, t.date)
);
const upsertProfileSetting = db.prepare(
  `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, ?, ?)
   ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
);
upsertProfileSetting.run("active_situations", JSON.stringify(["Illness"]));
upsertProfileSetting.run(
  "situation_events",
  serializeSituationEvents([], situationEvents)
);

// ── Trends pins + saved views (Trends Ph2/Ph3) ───────────────────────────────
upsertProfileSetting.run(
  "trend_pins",
  JSON.stringify([
    "metric:weight",
    "bio:LDL Cholesterol",
    "bio:Vitamin D, 25-Hydroxy",
  ])
);
upsertProfileSetting.run(
  "trend_views",
  JSON.stringify([
    {
      name: "Lipids review",
      params: { tab: "biomarkers", pins: ["bio:LDL Cholesterol", "bio:ApoB"] },
    },
    {
      name: "Cut progress",
      params: {
        tab: "body",
        from: daysAgo(120),
        to: daysAgo(0),
        pins: ["metric:weight", "metric:bodyfat"],
      },
    },
  ])
);

// ── Refill tracking — low days-of-supply → Upcoming refill signal.
const setSupply = db.prepare(
  `UPDATE intake_items SET quantity_on_hand = ?, qty_per_dose = ? WHERE profile_id = 1 AND name = ?`
);
setSupply.run(0, 1, "Sertraline"); // out of supply → Today band
setSupply.run(8, 1, "Magnesium Glycinate"); // ≈8 days left → This week band

// ── A goal that's behind pace (Trends projection + Upcoming deadline) ─────────
// Aggressive weight target with a deadline this week: baseline 84 → 74 with the
// current weigh-in near 80, so the projection reads "behind".
bodyGoal.run("Reach 74 kg", "body", 74, "weight", 84, daysAgo(-6));

// ── Upcoming snooze/dismiss — populate the "Snoozed & dismissed" section.
// Both keys point at genuinely-firing stale-biomarker signals (Uric Acid & Free
// T4 are >1y old), so each is a real suppression the restore UI can list. Ferritin
// stays live, so the biomarker band still has an item.
const dismissIns = db.prepare(
  `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
   VALUES (1,?,?,?)`
);
dismissIns.run("biomarker:uric acid", daysAgo(-5), null); // snoozed 5 days out
dismissIns.run("biomarker:free t4", null, `${daysAgo(0)} 09:00:00`); // dismissed

// ── Import log — one completed medical-document import, linked to the most
// recent lab draw's rows so /import shows a real "produced N rows" breakdown. No
// blob is needed on disk: content_hash is pre-set so the boot hash-backfill skips
// it, and the row only feeds the log/detail views.
const docIns = db.prepare(
  `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type, source,
      document_date, patient_name, extraction_status, extracted_count, content_hash, uploaded_at)
   VALUES (1,?,?,?,?,?,?,?,?, 'done', 0, ?, ?)`
);
const docId = Number(
  docIns.run(
    "labcorp-panel.pdf",
    "data/uploads/medical/1/seed-labcorp-panel.pdf",
    "application/pdf",
    148213,
    "lab_report",
    "upload",
    daysAgo(30),
    null,
    "seed00000000000000000000000000000000000000000000000000000000labc",
    `${daysAgo(30)} 08:30:00`
  ).lastInsertRowid
);
const linkedRows = db
  .prepare(
    `UPDATE medical_records SET document_id = ?, source = 'extracted'
       WHERE profile_id = 1 AND date = ? AND category IN ('lab','biomarker')`
  )
  .run(docId, daysAgo(30));
db.prepare(
  `UPDATE medical_documents SET extracted_count = ? WHERE id = ? AND profile_id = 1`
).run(linkedRows.changes, docId);

// ---------------------------------------------------------------------------
// A second, CHILD profile so the pediatric growth trends have a subject out of
// the box (kids growth trends). ~18 months old with a known sex + birthdate, a
// synthetic weight / height / head-circumference history — so the Trends → Body
// tab renders the WHO growth-percentile card, charts height + head circ, and the
// age-aware layout hides body fat. All values are obviously-synthetic, plausible
// WHO-range infant measurements. The admin login sees every profile (grants are
// bypassed for admins), so no login_profiles grant is needed to reach it.
const CHILD_NAME = "Riley (child)";
const existingChild = db
  .prepare("SELECT id FROM profiles WHERE name = ?")
  .get(CHILD_NAME) as { id: number } | undefined;
if (!existingChild) {
  const childId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(CHILD_NAME)
      .lastInsertRowid
  );
  // ~18 months old: WHO reference (0–24 mo) applies, so height/weight/head-circ
  // all score against the WHO curves and head-circ entry is offered.
  const childBirthdate = shiftDateStr(today(childId), -548);
  const setChildSetting = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO NOTHING`
  );
  setChildSetting.run(childId, "sex", "female");
  setChildSetting.run(childId, "birthdate", childBirthdate);

  const childDaysAgo = (n: number): string => shiftDateStr(today(childId), -n);

  // Weight history (kg) → body_metrics. Dates run oldest→newest over the last
  // ~6 months (child aged ~12 mo → ~18 mo across the window).
  const insChildWeight = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes) VALUES (?, ?, ?, ?)`
  );
  const weighIns: [number, number][] = [
    [180, 9.6],
    [120, 10.1],
    [60, 10.5],
    [0, 10.9],
  ];
  for (const [ago, kg] of weighIns) {
    insChildWeight.run(childId, childDaysAgo(ago), kg, "Well-child visit");
  }

  // Height (cm) + head circumference (cm) → metric_samples, exactly where the
  // growth charts + Body height/head-circ charts read (source 'manual', a fixed
  // midnight point window per date, mirroring the manual quick-add writer).
  const insChildSample = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)`
  );
  const point = (metric: string, ago: number, value: number) => {
    const d = childDaysAgo(ago);
    const ts = `${d}T00:00:00`;
    insChildSample.run(childId, metric, d, ts, ts, value);
  };
  const heights: [number, number][] = [
    [180, 74.2],
    [120, 77.1],
    [60, 79.5],
    [0, 81.4],
  ];
  for (const [ago, cm] of heights) point("height_cm", ago, cm);
  const headCircs: [number, number][] = [
    [180, 45.6],
    [120, 46.4],
    [60, 47.1],
    [0, 47.8],
  ];
  for (const [ago, cm] of headCircs) point("head_circumference_cm", ago, cm);
}

// ── Sleep sessions → Sleep Regularity Index (#160) ────────────────────────────
// 30 nightly sleep sessions for the adult profile (bed ~23:00 → wake ~07:00, with
// weekend nights shifted ~90 min later) so the Trends → Body "Sleep regularity"
// card (SRI) and the weekly-recap line have data. Stored as absolute instants
// (source 'manual'), keyed on the time window like the Health Connect ingest.
const insSleep = db.prepare(
  `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
);
for (let i = 1; i <= 30; i++) {
  const wakeDay = daysAgo(i);
  const bedDay = shiftDateStr(wakeDay, -1);
  const dow = new Date(wakeDay + "T00:00:00Z").getUTCDay(); // 0=Sun … 6=Sat
  const weekend = dow === 0 || dow === 6;
  // A small deterministic jitter (±10 min) keeps the schedule realistic rather
  // than a perfect SRI = 100.
  const jitter = ((i * 7) % 21) - 10;
  const bedMin = (weekend ? 30 : 0) + jitter; // 00:30 weekend vs 23:00 weekday
  const start = weekend
    ? `${wakeDay}T00:${String(Math.max(0, bedMin)).padStart(2, "0")}:00Z`
    : `${bedDay}T23:${String(Math.max(0, jitter + 30)).padStart(2, "0")}:00Z`;
  const wakeMin = weekend ? 30 : 0;
  const end = weekend
    ? `${wakeDay}T08:${String(wakeMin).padStart(2, "0")}:00Z`
    : `${wakeDay}T07:${String(Math.max(0, jitter + 30)).padStart(2, "0")}:00Z`;
  insSleep.run(SEED_PROFILE_ID, wakeDay, start, end, 480);
}

console.log("✅ Seeded sample health data.");
