import type { Sex } from "./types";

// Curated preventive-care catalog: age/sex-banded well-visit milestones and a
// small, USPSTF-derived screening subset. This is the single static source the
// pure assessor (`lib/preventive-status.ts`) reads from, mirroring the
// immunization catalog's typed-rules pattern (`lib/immunization-catalog.ts`).
//
// This is a SIMPLIFIED, informational subset for personal tracking — it is NOT
// clinical software and does NOT constitute medical advice. It deliberately does
// not model race/ethnicity, sexual-activity/STI risk, occupational exposure, or
// most shared-decision nuance. Risk-adjusted rules that need inputs the app does
// not yet structure (smoking history) SHIP here but stay inert (`riskGated`)
// until those inputs exist (tracked separately). Anatomy edge cases
// (post-hysterectomy, etc.) are handled downstream by a per-profile
// "not applicable" override rather than new demographic modeling.
//
// Guidelines shift over time (colorectal screening moved 50→45; mammography
// start moved 50→40), so EVERY rule carries a `citation` naming its guideline
// body and a `reviewed` catalog-review date — the catalog must stay auditable.
// Citations name the guideline body only; they do not reproduce full clinical
// criteria.
//
// Ages are expressed in MONTHS throughout so one rule engine covers infant
// milestones (2-month well visit) and adult screenings (colorectal at 45y).
// 1 year = 12 months.

const Y = 12; // months per year, for readability in the tables below

// The date this catalog's recommendations were last reviewed against their
// sources. Bump when refreshing rules so downstream audit surfaces can show it.
export const CATALOG_REVIEWED = "2026-07";

export type PreventiveKind = "visit" | "screening";

// A guideline citation + review date, so a surfaced recommendation can always be
// traced to its source and its currency judged. `summary` is a one-line,
// plain-language paraphrase — not the full clinical criteria. `grade` is the
// USPSTF letter grade where applicable (A/B are the actionable ones).
export interface Citation {
  source: string; // e.g. "USPSTF", "AAP Bright Futures", "ADA / AAPD"
  summary: string;
  reviewed: string; // YYYY-MM
  grade?: string; // USPSTF grade (A, B, C, I) where applicable
}

interface BaseRule {
  // Stable key stored/echoed downstream (Upcoming items, findings bus, the
  // preventive_events/_overrides tables). NEVER renumber an existing key.
  key: string;
  name: string; // display label
  kind: PreventiveKind; // satisfaction semantics: visit=appointment, screening=result
  description: string; // plain-language "what this is", not advice
  sex?: Sex; // sex-restricted rule; absent = all
  // Months past the recommended point before the item reads "overdue" rather
  // than "due" — the tolerance band. Screenings get a looser grace than the
  // to-the-day pediatric milestones.
  graceMonths: number;
  citation: Citation;
  // Ships in the catalog but never fires (always not_recommended) because it
  // needs a risk input the app does not yet structure (smoking history). Kept
  // here so the rule is visible/auditable and activates in one place later.
  riskGated?: boolean;
  // Informational flag: the underlying recommendation is conditioned on BMI
  // (e.g. diabetes screening targets overweight/obese adults). The pure assessor
  // has no BMI input, so it surfaces the rule on age alone; a later record-aware
  // layer can gate it. Purely descriptive here.
  bmiGated?: boolean;
}

// A one-time well-child visit at a target age (AAP Bright Futures periodicity).
// `endMonths` is the age past which this specific milestone is no longer
// surfaced (typically the next milestone's age) — a missed 2-month visit stops
// being actionable once the child is well past it; the later milestones carry
// the schedule forward.
export interface MilestoneVisitRule extends BaseRule {
  kind: "visit";
  schedule: {
    type: "milestone";
    atMonths: number;
    endMonths: number;
    ageLabel: string; // human age band, e.g. "2 mo", "Newborn"
  };
}

// A recurring visit cadence satisfied by an appointment (annual physical,
// dental, vision, skin check). The clock runs from the last completed visit;
// with no history the first one is recommended from `startMonths`.
export interface RecurringVisitRule extends BaseRule {
  kind: "visit";
  schedule: {
    type: "recurring";
    startMonths: number;
    endMonths?: number; // age past which the cadence stops (open-ended if absent)
    intervalMonths: number;
  };
}

// A screening satisfied by a result/procedure. The rescreen clock runs from the
// last result; `intervalMonths` omitted means a once-in-window screening
// (e.g. hepatitis C once between 18 and 79). `endMonths` bounds the routine age
// window above (past it → not routinely recommended).
export interface ScreeningRule extends BaseRule {
  kind: "screening";
  schedule: {
    type: "screening";
    startMonths: number;
    endMonths: number;
    intervalMonths?: number;
  };
}

export type PreventiveRule =
  MilestoneVisitRule | RecurringVisitRule | ScreeningRule;

// ---------------------------------------------------------------------------
// Well-child visit milestones — AAP Bright Futures / Periodicity Schedule.
// Newborn, then 1/2/4/6/9/12/15/18/24/30 months; ages 3–21 are the recurring
// annual well visit below. Each milestone's window closes at the next one.
// ---------------------------------------------------------------------------
const WELL_CHILD_CITATION: Citation = {
  source: "AAP Bright Futures",
  summary:
    "Recommended well-child visit ages in the AAP/Bright Futures periodicity schedule.",
  reviewed: CATALOG_REVIEWED,
};

function milestone(
  key: string,
  atMonths: number,
  endMonths: number,
  ageLabel: string
): MilestoneVisitRule {
  return {
    key,
    name: `Well-child visit (${ageLabel})`,
    kind: "visit",
    description: `Routine well-child checkup recommended around ${ageLabel}.`,
    graceMonths: 1,
    citation: WELL_CHILD_CITATION,
    schedule: { type: "milestone", atMonths, endMonths, ageLabel },
  };
}

const WELL_CHILD_MILESTONES: MilestoneVisitRule[] = [
  milestone("wellchild_newborn", 0, 1, "Newborn"),
  milestone("wellchild_1mo", 1, 2, "1 mo"),
  milestone("wellchild_2mo", 2, 4, "2 mo"),
  milestone("wellchild_4mo", 4, 6, "4 mo"),
  milestone("wellchild_6mo", 6, 9, "6 mo"),
  milestone("wellchild_9mo", 9, 12, "9 mo"),
  milestone("wellchild_12mo", 12, 15, "12 mo"),
  milestone("wellchild_15mo", 15, 18, "15 mo"),
  milestone("wellchild_18mo", 18, 24, "18 mo"),
  milestone("wellchild_24mo", 24, 30, "24 mo"),
  milestone("wellchild_30mo", 30, 36, "30 mo"),
];

// ---------------------------------------------------------------------------
// Recurring visit cadences (satisfied by an appointment).
// ---------------------------------------------------------------------------
const RECURRING_VISITS: RecurringVisitRule[] = [
  {
    key: "wellchild_annual",
    name: "Annual well-child visit (ages 3–21)",
    kind: "visit",
    description:
      "Yearly well-child / adolescent checkup from age 3 through 21.",
    graceMonths: 3,
    citation: WELL_CHILD_CITATION,
    // Ages 3 through 21; hands off to the adult physical at 22.
    schedule: {
      type: "recurring",
      startMonths: 3 * Y,
      endMonths: 22 * Y,
      intervalMonths: 12,
    },
  },
  {
    key: "adult_physical",
    name: "Routine adult check-up",
    kind: "visit",
    description:
      "General periodic check-up with your primary-care provider. Cadence is individualized — a yearly default is used here.",
    graceMonths: 3,
    citation: {
      source: "General practice (informational)",
      summary:
        "Periodic health check-ups are common practice; the ideal interval is individualized and not a graded USPSTF recommendation.",
      reviewed: CATALOG_REVIEWED,
    },
    schedule: { type: "recurring", startMonths: 22 * Y, intervalMonths: 12 },
  },
  {
    key: "dental_cleaning",
    name: "Dental check-up & cleaning",
    kind: "visit",
    description:
      "Routine dental exam and cleaning, commonly about every 6 months (individualized).",
    graceMonths: 2,
    citation: {
      source: "ADA / AAPD",
      summary:
        "Regular dental visits recommended, with the interval individualized to risk (commonly ~6 months). First dental visit by about age 1.",
      reviewed: CATALOG_REVIEWED,
    },
    schedule: { type: "recurring", startMonths: 12, intervalMonths: 6 },
  },
  {
    key: "vision_exam",
    name: "Eye exam",
    kind: "visit",
    description:
      "Periodic comprehensive eye exam; frequency is individualized (commonly every 1–2 years).",
    graceMonths: 6,
    citation: {
      source: "AAO (informational)",
      summary:
        "Comprehensive eye exams recommended periodically; frequency individualized by age and risk.",
      reviewed: CATALOG_REVIEWED,
    },
    schedule: { type: "recurring", startMonths: 3 * Y, intervalMonths: 24 },
  },
  {
    key: "skin_check",
    name: "Skin check",
    kind: "visit",
    description:
      "Skin examination for concerning lesions. Not a general USPSTF-recommended routine screen — discuss with your provider, especially if higher risk.",
    graceMonths: 6,
    citation: {
      source: "USPSTF (I statement)",
      summary:
        "Evidence is insufficient to recommend for or against routine whole-body skin cancer screening in average-risk adults; individualized.",
      reviewed: CATALOG_REVIEWED,
      grade: "I",
    },
    schedule: { type: "recurring", startMonths: 18 * Y, intervalMonths: 12 },
  },
];

// ---------------------------------------------------------------------------
// Screenings (satisfied by a result/procedure). Curated USPSTF-derived subset.
// Intervals are conservative single-number stand-ins; modality-specific and
// result-aware intervals (colonoscopy 10y vs FIT annual, cytology vs HPV
// co-test) are refined by a later record-aware layer — this catalog defaults to
// the standard interval. NOT clinical guidance.
// ---------------------------------------------------------------------------
const SCREENINGS: ScreeningRule[] = [
  {
    key: "colorectal_cancer",
    name: "Colorectal cancer screening",
    kind: "screening",
    description:
      "Screening for colorectal cancer (e.g. colonoscopy or stool-based test). Interval depends on the test used.",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 45–75 for colorectal cancer; 76–85 is individualized. Multiple strategies (colonoscopy ~10y, annual stool-based, etc.).",
      reviewed: CATALOG_REVIEWED,
      grade: "A/B",
    },
    // Standard colonoscopy interval as the default; 45 through 75.
    schedule: {
      type: "screening",
      startMonths: 45 * Y,
      endMonths: 76 * Y,
      intervalMonths: 120,
    },
  },
  {
    key: "mammography",
    name: "Mammography (breast cancer screening)",
    kind: "screening",
    description:
      "Breast cancer screening with mammography, typically every 2 years.",
    sex: "female",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary: "Screen women 40–74 with biennial mammography.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    // Biennial, 40 through 74.
    schedule: {
      type: "screening",
      startMonths: 40 * Y,
      endMonths: 75 * Y,
      intervalMonths: 24,
    },
  },
  {
    key: "cervical_cancer",
    name: "Cervical cancer screening",
    kind: "screening",
    description:
      "Cervical cancer screening (Pap cytology and/or HPV testing). Interval depends on the test used.",
    sex: "female",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen women 21–65: cytology every 3 years (21–65), or HPV / co-testing every 5 years (30–65).",
      reviewed: CATALOG_REVIEWED,
      grade: "A",
    },
    // Conservative cytology default (3y); 21 through 65.
    schedule: {
      type: "screening",
      startMonths: 21 * Y,
      endMonths: 65 * Y,
      intervalMonths: 36,
    },
  },
  {
    key: "blood_pressure",
    name: "Blood pressure screening",
    kind: "screening",
    description: "Screening for high blood pressure (hypertension).",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 18+ for hypertension; frequency varies by age and prior readings (annual default used here).",
      reviewed: CATALOG_REVIEWED,
      grade: "A",
    },
    schedule: {
      type: "screening",
      startMonths: 18 * Y,
      endMonths: 120 * Y,
      intervalMonths: 12,
    },
  },
  {
    key: "lipid_screening",
    name: "Cholesterol (lipid) screening",
    kind: "screening",
    description: "Blood lipid panel to assess cardiovascular risk.",
    graceMonths: 6,
    citation: {
      source: "USPSTF",
      summary:
        "Lipid screening supports statin-use decisions in adults ~40–75; broader periodic screening is common (every ~5 years used here).",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    schedule: {
      type: "screening",
      startMonths: 35 * Y,
      endMonths: 76 * Y,
      intervalMonths: 60,
    },
  },
  {
    key: "diabetes_screening",
    name: "Diabetes / prediabetes screening",
    kind: "screening",
    description:
      "Blood glucose or A1c screening for type 2 diabetes and prediabetes. USPSTF targets overweight/obese adults.",
    graceMonths: 6,
    bmiGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "Screen adults 35–70 who are overweight or obese for prediabetes and type 2 diabetes, about every 3 years.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    schedule: {
      type: "screening",
      startMonths: 35 * Y,
      endMonths: 70 * Y,
      intervalMonths: 36,
    },
  },
  {
    key: "osteoporosis",
    name: "Osteoporosis screening (bone density)",
    kind: "screening",
    description: "Bone-density (DEXA) screening for osteoporosis.",
    sex: "female",
    graceMonths: 12,
    citation: {
      source: "USPSTF",
      summary:
        "Screen women 65+ for osteoporosis with bone measurement testing. The optimal rescreening interval is uncertain.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    // Open-ended above 65; conservative rescreen stand-in (interval uncertain).
    schedule: {
      type: "screening",
      startMonths: 65 * Y,
      endMonths: 120 * Y,
      intervalMonths: 60,
    },
  },
  {
    key: "hepatitis_c",
    name: "Hepatitis C screening",
    kind: "screening",
    description: "One-time blood test for hepatitis C infection.",
    graceMonths: 12,
    citation: {
      source: "USPSTF",
      summary: "Screen adults 18–79 for hepatitis C infection at least once.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    // Once-in-window (no interval).
    schedule: { type: "screening", startMonths: 18 * Y, endMonths: 79 * Y },
  },
  // ---- Risk-gated (inert until a structured smoking record exists) ----
  {
    key: "lung_cancer_ldct",
    name: "Lung cancer screening (low-dose CT)",
    kind: "screening",
    description:
      "Annual low-dose CT for adults 50–80 with a significant smoking history. Requires smoking history — inactive until that is recorded.",
    graceMonths: 6,
    riskGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "Annual low-dose CT for adults 50–80 with a 20 pack-year history who currently smoke or quit within 15 years.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    schedule: {
      type: "screening",
      startMonths: 50 * Y,
      endMonths: 80 * Y,
      intervalMonths: 12,
    },
  },
  {
    key: "aaa_ultrasound",
    name: "Abdominal aortic aneurysm screening",
    kind: "screening",
    description:
      "One-time ultrasound for men 65–75 who have ever smoked. Requires smoking history — inactive until that is recorded.",
    sex: "male",
    graceMonths: 12,
    riskGated: true,
    citation: {
      source: "USPSTF",
      summary:
        "One-time abdominal ultrasound for men 65–75 who have ever smoked.",
      reviewed: CATALOG_REVIEWED,
      grade: "B",
    },
    schedule: { type: "screening", startMonths: 65 * Y, endMonths: 75 * Y },
  },
];

// The full curated catalog — well-child milestones, recurring visits, then
// screenings. Order is display-friendly (pediatric → adult).
export const PREVENTIVE_CATALOG: PreventiveRule[] = [
  ...WELL_CHILD_MILESTONES,
  ...RECURRING_VISITS,
  ...SCREENINGS,
];

const BY_KEY = new Map<string, PreventiveRule>(
  PREVENTIVE_CATALOG.map((r) => [r.key, r])
);

// The catalog rule for a stable key, or undefined for an unknown key.
export function preventiveRuleByKey(key: string): PreventiveRule | undefined {
  return BY_KEY.get(key);
}

// A short human summary of a rule's cadence, for tooltips / audit surfaces.
export function ruleScheduleSummary(rule: PreventiveRule): string {
  const s = rule.schedule;
  switch (s.type) {
    case "milestone":
      return `One-time visit around ${s.ageLabel}`;
    case "recurring":
      return `Every ${s.intervalMonths} months${
        s.endMonths ? ` through age ${Math.floor(s.endMonths / Y)}` : ""
      }`;
    case "screening": {
      const from = Math.floor(s.startMonths / Y);
      const to = Math.floor(s.endMonths / Y);
      const cadence = s.intervalMonths
        ? `every ${s.intervalMonths} months`
        : "once";
      return `Ages ${from}–${to}, ${cadence}`;
    }
  }
}
