// Pre-generate the baked USPSTF preventive-screening dataset (lib/screenings.json)
// that the pure preventive-care catalog (lib/preventive-catalog.ts) loads its
// adult SCREENING rules from — issue #149. The committed JSON is the SOURCE OF
// TRUTH, HUMAN-REVIEWABLE, and a FIXED POINT of buildScreenings() (guarded by
// lib/__tests__/screenings-dataset.test.ts so the generator and the committed file
// can't silently diverge). No API key — the values are curated PUBLIC USPSTF
// grade A/B recommendations, so generation is fully deterministic:
//
//   npm run gen:screenings
//
// This mirrors the other baked datasets (gen-canonical-biomarkers / gen-fitness-
// norms / gen-bp-percentiles): a curated table → committed JSON → a pure engine
// reads it. The engine, satisfaction inference, Upcoming surfacing, snooze/dismiss
// suppression bus, and Telegram nudge are the EXISTING preventive-care machinery
// (issues #82/#83/#85/#86/#227) — this issue only bakes the screening data out of
// the TS literal into a regenerable dataset and adds a depression-screening rule.
//
// SIMPLIFIED, INFORMATIONAL subset for personal/household tracking — NOT clinical
// software and NOT medical advice. It deliberately does not model race/ethnicity,
// STI/occupational risk, pregnancy, or most shared-decision nuance. Risk-adjusted
// rules that need inputs the app cannot yet know (a structured smoking history)
// ship with `riskGated: true` and stay inert until those inputs exist. Anatomy
// edge cases (post-hysterectomy, etc.) are the downstream per-profile
// "not applicable" override, not new demographic modeling. Guidelines shift over
// time (colorectal moved 50→45; mammography 50→40), so `reviewed` dates the whole
// dataset and every row carries a plain-language `citation` naming its source +
// USPSTF letter grade. Citations name the guideline body only — they do NOT
// reproduce full clinical criteria.
//
// Ages are expressed in MONTHS so one engine covers this dataset and the
// pediatric well-child milestones that live (as TS) alongside it. 1 year = 12mo.
//
// ── SOURCING (public USPSTF grade A/B recommendation statements) ────────────────
// Blood pressure — USPSTF A: screen adults ≥18 for hypertension.
// Cholesterol (lipids) — USPSTF B: lipid screening informs statin decisions in
//   adults ~40–75; broader periodic screening is common practice.
// Colorectal cancer — USPSTF A (50–75) / B (45–49): screen adults 45–75; 76–85 is
//   individualized. Multiple strategies (colonoscopy ~10y, annual stool-based, …).
// Cervical cancer — USPSTF A: screen women 21–65 (cytology q3y, or HPV/co-test q5y
//   from 30).
// Breast cancer (mammography) — USPSTF B: biennial mammography, women 40–74.
// Diabetes / prediabetes — USPSTF B: screen adults 35–70 who are overweight/obese.
// Depression — USPSTF B: screen adults ≥18 (incl. pregnancy/postpartum) and
//   adolescents 12–18 for major depressive disorder where follow-up care exists.
// Abdominal aortic aneurysm — USPSTF B: one-time ultrasound, men 65–75 who ever
//   smoked (risk-gated — inert until a smoking history is recorded).
// Osteoporosis — USPSTF B: screen women ≥65 with bone-measurement testing.
// (Hepatitis C — USPSTF B: adults 18–79 once — and lung-cancer LDCT — USPSTF B,
//  risk-gated — are carried too, from the prior curated subset.)

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "screenings.json");

const Y = 12; // months per year, for readability in the tables below

// The month the dataset was last reviewed against its USPSTF sources. Bump when
// refreshing rows so the auditable "reviewed" date downstream stays honest.
const REVIEWED = "2026-07";

// A guideline citation for a baked screening row. `summary` is a one-line
// plain-language paraphrase (not the full clinical criteria); `grade` is the
// USPSTF letter grade (A/B are the actionable ones). `reviewed` is injected from
// the dataset-level REVIEWED when the catalog reconstructs the full Citation.
export interface ScreeningCitation {
  source: string;
  summary: string;
  grade?: string;
}

// One baked screening row. Structurally a `ScreeningRule` minus the constant
// `kind: "screening"` / `schedule.type: "screening"` discriminants and the
// per-row `citation.reviewed` (all reconstructed in lib/preventive-catalog.ts).
export interface ScreeningRow {
  key: string; // stable rule key — NEVER renumber (stored in dismissals/events)
  name: string;
  description: string;
  sex?: "male" | "female"; // sex-restricted; absent = all
  graceMonths: number; // months past due before "overdue" rather than "due"
  riskGated?: boolean; // ships inert (needs a risk input the app can't yet know)
  bmiGated?: boolean; // informational: recommendation is BMI-conditioned
  citation: ScreeningCitation;
  schedule: {
    startMonths: number;
    endMonths: number;
    intervalMonths?: number; // omitted = once-in-window (a prior result satisfies)
  };
}

export interface ScreeningsDataset {
  $comment: string;
  reviewed: string;
  screenings: ScreeningRow[];
}

// The curated USPSTF grade A/B screening subset. Order is display-friendly
// (general adult → sex-specific → risk-gated last).
const SCREENINGS: ScreeningRow[] = [
  {
    key: "blood_pressure",
    name: "Blood pressure screening",
    description: "Screening for high blood pressure (hypertension).",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 18+ for hypertension; frequency varies by age and prior readings (annual default used here).",
      grade: "A",
    },
    schedule: { startMonths: 18 * Y, endMonths: 120 * Y, intervalMonths: 12 },
  },
  {
    key: "lipid_screening",
    name: "Cholesterol (lipid) screening",
    description: "Blood lipid panel to assess cardiovascular risk.",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Lipid screening supports statin-use decisions in adults ~40–75; broader periodic screening is common (every ~5 years used here).",
      grade: "B",
    },
    schedule: { startMonths: 35 * Y, endMonths: 76 * Y, intervalMonths: 60 },
  },
  {
    key: "colorectal_cancer",
    name: "Colorectal cancer screening",
    description:
      "Screening for colorectal cancer (e.g. colonoscopy or stool-based test). Interval depends on the test used.",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 45–75 for colorectal cancer; 76–85 is individualized. Multiple strategies (colonoscopy ~10y, annual stool-based, etc.).",
      grade: "A/B",
    },
    // Standard colonoscopy interval as the default; 45 through 75.
    schedule: { startMonths: 45 * Y, endMonths: 76 * Y, intervalMonths: 120 },
  },
  {
    key: "diabetes_screening",
    name: "Diabetes / prediabetes screening",
    description:
      "Blood glucose or A1c screening for type 2 diabetes and prediabetes. USPSTF targets overweight/obese adults.",
    graceMonths: 6,
    bmiGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 35–70 who are overweight or obese for prediabetes and type 2 diabetes, about every 3 years.",
      grade: "B",
    },
    schedule: { startMonths: 35 * Y, endMonths: 70 * Y, intervalMonths: 36 },
  },
  {
    key: "depression_screening",
    name: "Depression screening",
    description:
      "Screening for depression (e.g. a PHQ-2 / PHQ-9 questionnaire) in adolescents and adults.",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adolescents 12–18 and adults 18+ (including during pregnancy and postpartum) for depression where follow-up care is available. Optimal rescreening interval is not established (annual default used here).",
      grade: "B",
    },
    // Adolescent (12–18) + adult are both grade B; open-ended above with an annual
    // stand-in cadence (USPSTF does not specify an interval).
    schedule: { startMonths: 12 * Y, endMonths: 120 * Y, intervalMonths: 12 },
  },
  {
    key: "hepatitis_c",
    name: "Hepatitis C screening",
    description: "One-time blood test for hepatitis C infection.",
    graceMonths: 12,
    citation: {
      source: "USPSTF",
      summary: "Screen adults 18–79 for hepatitis C infection at least once.",
      grade: "B",
    },
    // Once-in-window (no interval).
    schedule: { startMonths: 18 * Y, endMonths: 79 * Y },
  },
  {
    key: "cervical_cancer",
    name: "Cervical cancer screening",
    description:
      "Cervical cancer screening (Pap cytology and/or HPV testing). Interval depends on the test used.",
    sex: "female",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen women 21–65: cytology every 3 years (21–65), or HPV / co-testing every 5 years (30–65).",
      grade: "A",
    },
    // Conservative cytology default (3y); 21 through 65.
    schedule: { startMonths: 21 * Y, endMonths: 65 * Y, intervalMonths: 36 },
  },
  {
    key: "mammography",
    name: "Mammography (breast cancer screening)",
    description:
      "Breast cancer screening with mammography, typically every 2 years.",
    sex: "female",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary: "Screen women 40–74 with biennial mammography.",
      grade: "B",
    },
    // Biennial, 40 through 74.
    schedule: { startMonths: 40 * Y, endMonths: 75 * Y, intervalMonths: 24 },
  },
  {
    key: "osteoporosis",
    name: "Osteoporosis screening (bone density)",
    description: "Bone-density (DEXA) screening for osteoporosis.",
    sex: "female",
    graceMonths: 12,
    citation: {
      source: "USPSTF",
      summary:
        "Screen women 65+ for osteoporosis with bone measurement testing. The optimal rescreening interval is uncertain.",
      grade: "B",
    },
    // Open-ended above 65; conservative rescreen stand-in (interval uncertain).
    schedule: { startMonths: 65 * Y, endMonths: 120 * Y, intervalMonths: 60 },
  },
  // ---- Risk-gated (inert until a structured smoking record exists) ----
  {
    key: "lung_cancer_ldct",
    name: "Lung cancer screening (low-dose CT)",
    description:
      "Annual low-dose CT for adults 50–80 with a significant smoking history. Requires smoking history — inactive until that is recorded.",
    graceMonths: 6,
    riskGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "Annual low-dose CT for adults 50–80 with a 20 pack-year history who currently smoke or quit within 15 years.",
      grade: "B",
    },
    schedule: { startMonths: 50 * Y, endMonths: 80 * Y, intervalMonths: 12 },
  },
  {
    key: "aaa_ultrasound",
    name: "Abdominal aortic aneurysm screening",
    description:
      "One-time ultrasound for men 65–75 who have ever smoked. Requires smoking history — inactive until that is recorded.",
    sex: "male",
    graceMonths: 12,
    riskGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "One-time abdominal ultrasound for men 65–75 who have ever smoked.",
      grade: "B",
    },
    schedule: { startMonths: 65 * Y, endMonths: 75 * Y },
  },
];

// Pure builder: assemble the dataset from the curated table. The committed
// lib/screenings.json is a FIXED POINT of this (guarded by the dataset test).
export function buildScreenings(): ScreeningsDataset {
  return {
    $comment:
      "Baked USPSTF preventive-screening dataset (issue #149) read by " +
      "lib/preventive-catalog.ts. Curated PUBLIC USPSTF grade A/B recommendations — " +
      "see scripts/gen-screenings.ts for per-row sourcing. Committed + HUMAN-" +
      "REVIEWABLE; regenerate with `npm run gen:screenings`. SIMPLIFIED and " +
      "INFORMATIONAL for personal/household tracking, NOT clinical software or " +
      "medical advice. `reviewed` dates the whole dataset; risk-gated rows stay " +
      "inert until the risk input exists.",
    reviewed: REVIEWED,
    screenings: SCREENINGS,
  };
}

function writeDataset(): void {
  const dataset = buildScreenings();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.screenings.length} screenings to ${OUT}`);
  console.log(
    "Review the age/sex bands + citations against USPSTF before committing."
  );
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildScreenings).
if (process.argv[1]?.includes("gen-screenings")) {
  writeDataset();
}
