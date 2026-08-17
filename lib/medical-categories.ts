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
// RESULTS_CATALOG_CATEGORIES is the set the flat Results catalog (/results/clinical-results,
// rendered as Results › Clinical results) can list/filter/add. It drops the #1076 re-homed
// classes that HAVE a dedicated home:
//   • 'prescription' — medications; live on the document view + Supplements & Meds.
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
// (app/(app)/results/clinical-result-index.ts) and the panel facet
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
  "scan",
  "prescription",
  "instrument",
  "derived",
  "reference",
  "report",
  "assessment",
] as const satisfies readonly MedicalCategory[];

// The categories a NEW or EDITED row may be filed under. #2877 removed the final
// retired enum member, so this alias keeps the shared writer/picker contract without a
// second list that can drift.
export const ASSIGNABLE_MEDICAL_CATEGORIES = MEDICAL_CATEGORIES;

export const RESULTS_CATALOG_CATEGORIES = [
  "lab",
  "vitals",
  "genomics",
  "scan",
] as const satisfies readonly MedicalCategory[];

// The complement of RESULTS_CATALOG_CATEGORIES — the categories the flat catalog
// EXCLUDES (#1076): the re-homed classes with a dedicated home (instruments, derived
// bio-age, immutable facts) plus prescriptions. Kept as
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
//   • registers no `canonical_result_definitions` name on import (both the deterministic
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

// ---- The SCREENING-RESULT axis (issue #3025) -------------------------------
//
// A FOURTH question, independent of the three above: may a record in this category be
// read as EVIDENCE THAT A SCREENING HAPPENED — the record stream the preventive
// assessor infers satisfactions from (#86, lib/queries/upcoming/preventive.ts)?
//
// It used to be an ALLOWLIST of four categories held in that query module, and an
// allowlist fails silently in the dangerous direction. A cytology report imported from a
// CCDA lands as `report`; its name matches the concept map's `pap test` needle exactly,
// and it was dropped before any matching ran — so a profile whose Pap was 23 months old
// got an "overdue cervical cancer screening" nudge. Nobody had ruled `report` out; nobody
// had ruled it in either, and a category nobody considered produced a nudge for a
// screening the record already proved, with no error anywhere.
//
// So the gate is a DENYLIST, and this table classifies EVERY member of the enum rather
// than listing one side. A category is admitted unless it is ruled out here WITH ITS
// REASON, which makes "we decided against it" and "nobody looked" stay distinguishable —
// the #2786 discipline. The `Record<MedicalCategory, …>` is what gives it teeth: a new
// enum member that never answered this question is a TYPE error, not a silent drop.
//
// WHICH DIRECTION THIS MOVES A SAFETY SIGNAL, stated carefully because the first draft
// of this comment got it wrong. Admitting a category can only ever ADD satisfactions,
// i.e. make a screening nudge QUIETER — and a quieter nudge is a MISSED SCREENING, which
// is the expensive failure, not the cheap one. The draft called it cheap on the grounds
// that "an admitted category still has to clear the concept map's whole-word needles",
// and that is only a defence when the needles can tell a RESULT from a mention: admitting
// `report` pointed those needles at DOCUMENT TITLES for the first time, and "Nutrition
// Counseling Note" then satisfied depression and anxiety screening for a year. So the
// admission is paid for on the other side of the gate too, in `EvidenceShape` and the
// document-prose guards in lib/preventive-inference.ts: which needles a document TITLE
// may be read with, whether a refusal in the title withholds the subject beside it, and
// whether the document is a REQUEST for a screening rather than a record of one. Those
// guards touch the name path only — an exact code or canonical name is an identity, and
// prose may never withhold an identity. The categories ruled out below are ruled out for
// a reason about what the row IS, never to keep the signal loud.
export interface ScreeningResultRuling {
  // May a row in this category satisfy a preventive screening rule?
  admits: boolean;
  // Why — required in BOTH directions.
  why: string;
}

export const SCREENING_RESULT_CATEGORIES: Record<
  MedicalCategory,
  ScreeningResultRuling
> = {
  lab: {
    admits: true,
    why: "A measured reading with a name and a date — a cholesterol panel, an A1c, a glucose. The original case #86 was built for.",
  },
  vitals: {
    admits: true,
    why: "A dated physiologic reading; a blood pressure IS the hypertension screening's result.",
  },
  instrument: {
    admits: true,
    why: "A validated screening instrument's TOTAL SCORE (#1076) — a PHQ-9 satisfies depression screening, an AUDIT-C alcohol screening. Admitted the last time this list was extended.",
  },
  report: {
    admits: true,
    why: "The narrative body of a cytology / pathology / imaging read (#708) — precisely the document that PROVES a screening happened. It carries no value, so the qualitative-result bridge (#686) can never judge it, and its name is all the evidence there is: 'Cytology, Gyn-PAP Test (AP)' matches the cervical concept's `pap test` needle. This is the #3025 case.",
  },
  genomics: {
    admits: false,
    why: "A genotype is an immutable fact about the person, not an event on a screening clock. It has no recurrence interval to reset.",
  },
  scan: {
    admits: false,
    why: "A numeric imaging MEASUREMENT (a DEXA density). The study itself satisfies through the PROCEDURE stream, which carries the code and the indication; counting the measurement too would be a second, weaker derivation of the same event.",
  },
  prescription: {
    admits: false,
    why: "A medication, not a result. Being on a statin is not a lipid panel.",
  },
  derived: {
    admits: false,
    why: "A computed composite (Biological Age, PhenoAge). It is arithmetic over other rows, so it can prove no encounter took place — and it would inherit whatever dates its inputs had.",
  },
  reference: {
    admits: false,
    why: "An immutable identity fact (blood type). Never repeated, so never a screening on a clock.",
  },
  assessment: {
    admits: false,
    why: "The one exclusion that is NOT in the original comment, decided here (#3025): an assessment carries NO RESULT IDENTITY at all (NON_IDENTITY_CATEGORIES, #2318). A questionnaire ITEM answer or a temperature's body site is a FRAGMENT of another row's result, not a result in its own right, so it can prove nothing about whether a screening was performed — and the rows whose totals do prove it are `instrument`, which is admitted.",
  },
};

// May a record in this category satisfy a preventive screening rule (#3025)?
//
// WHERE THE PROTECTION ACTUALLY LIVES: the `Record<MedicalCategory, …>` above. A new
// enum member that never answered this question does not compile, which is what makes
// "we decided against it" and "nobody looked" stay distinguishable at the only moment
// anybody can act on the difference. That is the whole mechanism.
//
// THE UNKNOWN-STRING FALLBACK IS BELT-AND-BRACES, NOT THE MECHANISM, and an earlier
// draft of this comment claimed otherwise. `medical_records.category` carries a CHECK
// constraint, and migration 20260814-medical-category-residue rebuilt the table WITHOUT
// the retired `biomarker` bucket, mapping the rows that still carried it to NULL. So no
// stored row can present a category string this table has never met, and no importer can
// invent one; the fallback is unreachable from the database and is kept only so this
// function is total over its argument type.
//
// NULL is NOT a category. It is the legacy catch-all residue that still owes an explicit
// category decision (#2877, `getUncategorizedRecords`), and it is left excluded exactly
// as it was — widening the single largest uncurated population is not what this gate is
// for.
export function categorySatisfiesScreening(
  category: string | null | undefined
): boolean {
  if (category == null) return false;
  const ruling: ScreeningResultRuling | undefined = (
    SCREENING_RESULT_CATEGORIES as Record<string, ScreeningResultRuling>
  )[category];
  return ruling ? ruling.admits : true;
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
