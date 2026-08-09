// The NAME/SHAPE axis of "this observation is not a measurement" (#2318) — the twin
// of the CODE axis that already exists in lib/biomarker-loinc.ts.
//
// `functionalStatusExtractor` has always nulled the assessment LOINC before storing,
// and said why: these are assessment instruments, not lab analytes, so carrying the
// code forward would invite canonical biomarker-map additions that would be wrong.
// That reasoning is right and the mitigation works — but only for CODES. Identity in
// this app also runs on the NAME: `addCanonicalNames` registers it,
// `getUsedCanonicalNames` feeds coverage candidacy and every "used analyte" series,
// `biomarkerCoverageKey` folds it. With no guard on that axis the outcome the comment
// set out to prevent happened anyway one surface over: a temperature's body SITE, a
// vaccine LOT NUMBER and EXPIRY, a generic result-status word and every individual
// depression-screening QUESTION TEXT each acquired an ai-coined canonical name, a
// bandless series, and a permanent slot under Data → Coverage → Uncatalogued items.
//
// This module is that guard, as PURE predicates so three consumers share ONE rule:
// the CDA observation mapper (which routes a match to the `assessment` category
// instead of `lab`), the migration-177 backfill (which re-homes the rows already
// stored), and the pure test tier.
//
// Nothing here DROPS a reading except the immunization-attribute refusal: an
// assessment or qualifier is still stored, still tied to its document, still viewable.
// The question is only what earns a BIOMARKER identity.

// C-CDA Assessment Scale Observation (2.16.840.1.113883.10.20.22.4.69) and its
// per-item Assessment Scale Supporting Observation (…4.86) — the template pair a
// screening instrument (PHQ-9, GAD-7, a fall-risk scale) and its individual answered
// ITEMS ship under. The item observations carry real survey LOINCs, so the
// "no analyte identity" test below would let them through on the code axis; the
// template is what says "this is a questionnaire item", whatever section it sits in.
export const ASSESSMENT_SCALE_TEMPLATES: readonly string[] = [
  "2.16.840.1.113883.10.20.22.4.69",
  "2.16.840.1.113883.10.20.22.4.86",
];

const ASSESSMENT_SCALE_TEMPLATE_SET = new Set(ASSESSMENT_SCALE_TEMPLATES);

// Whether a template root marks an assessment-scale observation or one of its items.
export function isAssessmentScaleTemplate(root: unknown): boolean {
  return (
    typeof root === "string" && ASSESSMENT_SCALE_TEMPLATE_SET.has(root.trim())
  );
}

const blank = (s: string | null | undefined): boolean =>
  s == null || String(s).trim() === "";

// What a reading looks like, as far as "is this a measurement?" is concerned. The
// four fields are exactly the ones both consumers have: the CDA mapper reads them off
// the observation node, the backfill reads them off the stored row.
export interface ObservationShape {
  loinc: string | null | undefined;
  valueNum: number | null | undefined;
  unit: string | null | undefined;
  referenceRange: string | null | undefined;
  // The observation declared a C-CDA assessment-scale template (mapper only; a stored
  // row has no memory of it — see the migration's note on that boundary).
  assessmentScale?: boolean;
}

// A NON-ANALYTE observation: it states no measurement AND it claims no analyte
// identity.
//
//   • no measurement — no numeric value, no unit, no stated reference range. A
//     qualifier ("Oral", "Left arm"), a status word, a free-text questionnaire answer
//     and a printed expiry date all land here; a genuinely scored reading never does,
//     which is what keeps a numeric screening TOTAL out of this bucket (scoring an
//     instrument is a separate decision — see the issue's out-of-scope note).
//   • no analyte identity — no resolvable LOINC at all, OR a C-CDA assessment-scale
//     template, which says "questionnaire item" even when the item carries a survey
//     LOINC.
//
// Deliberately CONSERVATIVE on the code axis, in the same spirit as
// NON_ANALYTE_LOINCS: an observation that carries a LOINC and is not an
// assessment-scale item is left alone, because a genuine QUALITATIVE lab result
// ("Positive", "Detected", a blood type) is exactly that shape and must keep its
// series.
export function isNonAnalyteObservation(shape: ObservationShape): boolean {
  const statesNoMeasurement =
    shape.valueNum == null && blank(shape.unit) && blank(shape.referenceRange);
  const claimsNoAnalyte = blank(shape.loinc) || shape.assessmentScale === true;
  return statesNoMeasurement && claimsNoAnalyte;
}

// ── Immunization product attributes (#2318 part 3) ──────────────────────────
// A vaccine's LOT NUMBER and EXPIRY are attributes of the immunization entry — which
// has its own store, where the lot already rides as provenance (mapImmunization). A
// document that files them as free-standing observations is describing the product,
// not measuring the patient, so the generic observation mapper emits NOTHING for them
// rather than minting a `ccda:obs:` record that then coins an analyte name.
//
// Matched on the printed LABEL because that is all these rows carry: they arrive with
// no LOINC (an EHR-local code at best) and a text value. None of these labels names a
// measurement in any lab vocabulary, in any specimen — "Lot Number" is never an
// analyte — so the match is safe without a shape test. A SPECIMEN expiration date is
// already dropped one axis over by LOINC 45374-6.
const IMMUNIZATION_ATTRIBUTE_LABELS = new Set([
  "lot",
  "lot no",
  "lot num",
  "lot number",
  "vaccine lot",
  "vaccine lot number",
  "expiration",
  "expiration date",
  "expiry",
  "expiry date",
  "exp date",
  "vaccine expiration date",
]);

// Normalize a printed label for matching: case-fold, collapse whitespace, and drop
// the trailing punctuation a narrative table adds ("Lot Number:", "Lot #").
function normalizeLabel(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/[#:.]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Whether a printed observation label names an immunization product attribute the
// immunization entry already owns.
export function isImmunizationAttributeLabel(
  name: string | null | undefined
): boolean {
  return IMMUNIZATION_ATTRIBUTE_LABELS.has(normalizeLabel(name));
}
