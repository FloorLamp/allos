import type { Sex } from "./types";
import {
  SCREENING_ROWS,
  SCREENINGS_REVIEWED as SCREENINGS_DATASET_REVIEWED,
} from "./datasets/screenings";

// Curated preventive-care catalog: age/sex-banded well-visit milestones and a
// small, USPSTF-derived screening subset. This is the single static source the
// pure assessor (`lib/preventive-status.ts`) reads from, mirroring the
// immunization catalog's typed-rules pattern (`lib/immunization-catalog.ts`).
//
// The SCREENING rules are baked (issue #149): their curated table lives in
// `scripts/gen-screenings.ts` and is committed as `lib/screenings.json`, loaded
// below — the same regenerable-dataset pattern the biomarker/fitness-norm tables
// use. The well-child milestones and recurring visits stay as typed TS literals
// here (they are not USPSTF screenings). Everything downstream — the pure
// assessor, record-driven satisfaction inference, Upcoming surfacing + snooze/
// dismiss suppression, and the Telegram nudge — is unchanged and shared.
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
    // Age-related hearing screening (issue #713) — the sense-organ trio's hearing arm,
    // the first hearing preventive rule (none existed). Satisfied by a `hearing`
    // appointment/audiogram. USPSTF gives an I statement for screening asymptomatic
    // older adults, so this is a calm, individualized default (like skin_check's I
    // statement) — surfaced from ~50, every ~3 years — that the risk layer (#717:
    // recorded noise exposure, active ototoxic medication) can bring due SOONER.
    key: "hearing_screening",
    name: "Hearing screening",
    kind: "visit",
    description:
      "Periodic hearing check for older adults (an audiogram / audiology visit). Frequency is individualized; brought due sooner by noise exposure or ototoxic-medication use.",
    graceMonths: 6,
    citation: {
      source: "USPSTF (I statement)",
      summary:
        "Evidence is insufficient to recommend for or against routine hearing-loss screening in asymptomatic older adults; individualized. Age-related hearing loss is common and often gradual.",
      reviewed: CATALOG_REVIEWED,
      grade: "I",
    },
    schedule: { type: "recurring", startMonths: 50 * Y, intervalMonths: 36 },
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
// Screenings (satisfied by a result/procedure). Curated USPSTF grade A/B subset,
// BAKED (issue #149): the data lives in scripts/gen-screenings.ts → the committed
// lib/screenings.json loaded below and reconstructed into typed ScreeningRules.
// Intervals are conservative single-number stand-ins; modality-specific and
// result-aware intervals (colonoscopy 10y vs FIT annual, cytology vs HPV
// co-test) are refined by a later record-aware layer — this catalog defaults to
// the standard interval. NOT clinical guidance.
// ---------------------------------------------------------------------------

// The month the screening dataset was last reviewed against USPSTF (from the
// framework dataset's meta). Exported for audit surfaces the way CATALOG_REVIEWED is.
export const SCREENINGS_REVIEWED = SCREENINGS_DATASET_REVIEWED;

// Reconstruct the fully-typed screening rules from the baked rows, re-attaching
// the constant `kind`/`schedule.type` discriminants and the dataset `reviewed`
// date onto each citation. Optional flags are only set when truthy so the shape
// matches the previous inline literals byte-for-byte for downstream consumers.
const SCREENINGS: ScreeningRule[] = SCREENING_ROWS.map((r) => ({
  key: r.key,
  name: r.name,
  kind: "screening",
  description: r.description,
  ...(r.sex ? { sex: r.sex } : {}),
  graceMonths: r.graceMonths,
  ...(r.riskGated ? { riskGated: true } : {}),
  ...(r.bmiGated ? { bmiGated: true } : {}),
  citation: {
    source: r.citation.source,
    summary: r.citation.summary,
    reviewed: SCREENINGS_REVIEWED,
    ...(r.citation.grade ? { grade: r.citation.grade } : {}),
  },
  schedule: {
    type: "screening",
    startMonths: r.schedule.startMonths,
    endMonths: r.schedule.endMonths,
    ...(r.schedule.intervalMonths != null
      ? { intervalMonths: r.schedule.intervalMonths }
      : {}),
  },
}));

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
