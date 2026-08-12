// The medical-record categories and clinical flags, shared by the record forms,
// the category filter, the medical write action, and the AI extractor so the
// option/accept sets can't drift. Pure data (client- and server-safe).
//
// THREE AXES, three mechanisms, and this file holds two of them (#2479). Which
// CLASS of clinical thing a row is (MEDICAL_CATEGORIES, the storage axis), whether
// the flat catalog may LIST it (RESULTS_CATALOG_CATEGORIES, the catalog axis) and
// whether it may claim an IDENTITY at all (NON_IDENTITY_CATEGORIES, below) are
// independent questions; quantitation is a property and none of the three. See
// docs/internals/clinical-result-terminology.md.
//
// MEDICAL_CATEGORIES is the full enum (mirrors lib/types.ts MedicalCategory and
// the medical_records CHECK — migration 090 grew it to include the #1076 classes).
// RESULTS_CATALOG_CATEGORIES is the set the flat Results catalog (/results/readings,
// rendered as Results › Biomarkers) can list/filter/add. It drops the #1076 re-homed
// classes that HAVE a dedicated home:
//   • 'prescription' — medications; live on the document view + Supplements & Meds.
//   • 'biomarker'  — the legacy pre-#1076 bucket, now emptied of real labs.
//   • 'instrument' — screening scores → mental-health / substance-use (SENSITIVITY:
//     a depression/alcohol score must never surface in a general health catalog).
//   • 'derived'    — bio-age composites → the Longevity bio-age hero.
//   • 'reference'  — immutable facts → the passport.
//   • 'report'     — narrative micro/path report bodies → Results → Reports (#708);
//     they carry text in `notes` with no value, so they must never appear in the
//     analyte catalog.
//   • 'assessment' — non-measurement assessments and qualifiers (#2318): a
//     functional-status finding, a questionnaire ITEM answer, a temperature's body
//     site. They are viewable on their document but carry no biomarker identity at
//     all (see NON_IDENTITY_CATEGORIES below), so the analyte catalog is one of the
//     several surfaces they must never reach.
// 'vitals' is browsable, but it is the one category whose membership is decided PER
// ANALYTE rather than as a class (#2365). #1076 kept the whole category to protect the
// DOMAIN vitals catalogued here — audiogram hearing thresholds (#713), intraocular
// pressure / visual acuity (#697), periodontal depth (#705) — which have no dedicated
// chart surface, so the flat catalog is their only reachable home and removing them
// would STRAND them. That reasoning still holds; the granularity was wrong. The
// category holds two populations, and keeping it whole to protect the small one dragged
// the large one along: on one real profile, 131 of 145 `vitals` rows were blood
// pressure / SpO2 / respiratory rate / body temperature / BMI — every one a quantity
// with its own `/trends/metric/<slug>` chart.
//
// So the "nothing stranded" rule is kept and applied a level finer: an analyte is
// listed unless an imported reading of it is ANSWERED ELSEWHERE — which is a stricter
// test than "a chart exists" (HRV and BMR have charts that no `medical_records` row
// can ever reach, so they stay). `lib/trend-metric-analytes.ts` decides, derived from
// the metric registries (`TREND_METRIC_SLUGS` + `METRIC_KNOWLEDGE`) plus a per-slug
// reachability declaration rather than hand-listed, so a future slug removes its
// analyte with no second edit here and the registries cannot drift apart. Category
// membership in RESULTS_CATALOG_CATEGORIES therefore no longer settles the vitals
// question on its own — ask that module (listedInResultsCatalog), which both the row gather
// (app/(app)/results/reading-index.ts) and the panel facet
// (lib/biomarker-panel-reach.ts) go through.
//
// The TRAJECTORY tab (Trends → Biomarkers) separately scopes to lab-only — that is
// where the years-axis grammar lives. 'genomics' and 'scan' are out of #1076's scope
// and stay browsable whole (numeric DEXA measurements).
import type { MedicalCategory, MedicalFlag } from "@/lib/types";

export const MEDICAL_CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
  "instrument",
  "derived",
  "reference",
  "report",
  "assessment",
] as const satisfies readonly MedicalCategory[];

export const RESULTS_CATALOG_CATEGORIES = [
  "lab",
  "vitals",
  "genomics",
  "scan",
] as const satisfies readonly MedicalCategory[];

// The complement of RESULTS_CATALOG_CATEGORIES — the categories the flat catalog
// EXCLUDES (#1076): the re-homed classes with a dedicated home (instruments, derived
// bio-age, immutable facts) plus the emptied legacy bucket and prescriptions. Kept as
// the derived complement so the two sets can't drift. (Physiologic-vitals TRAJECTORY
// scoping is a separate, tab-local exclusion in Trends → Biomarkers.)
export const NON_RESULTS_CATALOG_CATEGORIES = MEDICAL_CATEGORIES.filter(
  (c) => !(RESULTS_CATALOG_CATEGORIES as readonly MedicalCategory[]).includes(c)
);

// The categories that carry NO RESULT IDENTITY at all (#2318) — the identity axis,
// which is NOT the catalog axis above and NOT quantitation. Being absent from
// RESULTS_CATALOG_CATEGORIES only keeps a category out of the flat catalog; identity
// is a stronger, separate claim, and it is the one the four #2318 shapes were making
// by accident. Nor is "states no number" the test: a urine dipstick result and a
// blood group report a word and carry FULL identity, while a screening
// questionnaire's numeric ITEM answer is stored here precisely so it cannot coin a
// name (docs/internals/clinical-result-terminology.md). A row in one of these
// categories:
//
//   • registers no `canonical_biomarkers` name on import (both the deterministic
//     CCD/FHIR path and the AI path filter on this set), and
//   • is excluded from `getUsedCanonicalNames`, which is what feeds Coverage
//     candidacy (Data → Coverage → Uncatalogued items) AND every "the profile has
//     readings for this analyte" series enumeration, and
//   • contributes no point to `getBiomarkerSeries` — the series IS the identity, so
//     a direct by-name read cannot draw one either — and does not count as a backing
//     reading for the ★ / retest-dismissal de-orphan sweeps.
//
// One entry today. `report` is deliberately NOT here: that is the same question one
// domain over and a separate decision — this list exists so the next category has an
// obvious slot rather than a second copy of the filter.
export const NON_IDENTITY_CATEGORIES = [
  "assessment",
] as const satisfies readonly MedicalCategory[];

// Whether a record's category lets it claim a RESULT IDENTITY — a canonical name, a
// coverage candidacy, a series. Named for what it gates rather than for "biomarker"
// (#2479): the rows it refuses are not the non-quantitative ones, they are the ones
// the app deliberately denies an identity. Pure; the SQL side reads
// NON_IDENTITY_CATEGORIES directly (see lib/queries/medical.ts).
export function carriesResultIdentity(category: string): boolean {
  return !(NON_IDENTITY_CATEGORIES as readonly string[]).includes(category);
}

// The clinical flags a lab report can carry, and the only flags the AI extractor
// is allowed to emit / the write action accepts. The derived "non-optimal*"
// values in MedicalFlag (see lib/types.ts) are intentionally NOT here: they're
// reconciled in code from the canonical optimal band, never set by the lab or
// the model. Shared so the extractor's tool enum and the action's accept-list
// can't drift.
export const MEDICAL_FLAGS = [
  "normal",
  "high",
  "low",
  "abnormal",
] as const satisfies readonly MedicalFlag[];
