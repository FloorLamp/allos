// CDA section extractors — observations (lab results, vital signs, functional
// status). The shared observation mapper plus the result/vitals/functional-status
// section extractors.
import {
  canonicalBiomarkerForLoinc,
  isDerivedPercentileLoinc,
  isNonAnalyteLoinc,
  isVitalLoinc,
} from "../../biomarker-loinc";
import type {
  ImportedImagingStudy,
  ImportedProvider,
  ImportedRecord,
} from "../../health-import";
import type { MedicalFlag } from "../../types";
import {
  isAssessmentScaleTemplate,
  isImmunizationAttributeLabel,
  isNonAnalyteObservation,
} from "../../non-analyte-observations";
import { normalizeLaterality, normalizeModality } from "../../imaging-study";
import {
  VITAL_CANONICAL,
  normalizeImportedTemperature,
} from "../../vitals-input";
import { SECTIONS } from "../constants";
import type { CdaSection, SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeBlockMap,
  buildNarrativeIdMap,
  collapseNarrativeMap,
  effTime,
  hl7Period,
  loincDisplayName,
  loincFromCode,
  providerFromPerformer,
  rawQuantity,
  readValue,
  resolveNarrativeText,
  sectionIs,
  textOf,
  truthyNegation,
  unitFromEntryRelationships,
} from "../normalize";
import { sourceDay, sourceInstant } from "../../source-time";
import { normalizeDurationValue } from "../../duration-value";
import { foldInstrumentScores } from "../../instrument-import";
import type { InstrumentSubject } from "../../instrument-recognize";
import type { ImportDrop } from "../../import-report";

// ── Source-stated reference range + abnormal flag (CDA labs) ────────────────
// A CCD lab observation carries its OWN normal range (<referenceRange>) and the lab's
// H/L/N/A interpretation (<interpretationCode>). We capture both on `lab` records so an
// analyte the app has no canonical band for still shows the lab's range and flag —
// previously discarded (import-shape hard-coded them null). Scoped to labs: vitals keep
// their dedicated flag engines (BP percentiles #150, temp red-flag #859), and the flag
// only SEEDS the row — reconcileFlags refines a mapped lab against the canonical band
// and leaves an unmapped lab's source flag intact.

// Format a numeric IVL_PQ range (<low>/<high> with units) as "low–high unit", or a
// one-sided "≥ low" / "≤ high". Skips nullFlavor'd bounds.
function formatIvlPq(value: any): string | null {
  const bound = (n: any): { v: string; u: string } | null => {
    if (!n || n["@_nullFlavor"] != null || n["@_value"] == null) return null;
    return { v: String(n["@_value"]), u: String(n["@_unit"] ?? "").trim() };
  };
  const lo = bound(value?.low);
  const hi = bound(value?.high);
  const unit = hi?.u || lo?.u || String(value?.["@_unit"] ?? "").trim();
  const u = unit ? ` ${unit}` : "";
  if (lo && hi) return `${lo.v}–${hi.v}${u}`;
  if (lo) return `≥ ${lo.v}${u}`;
  if (hi) return `≤ ${hi.v}${u}`;
  return null;
}

// The reading's stated reference range: the first <observationRange>'s numeric IVL_PQ
// bounds, else its free-text/ED description (resolved through the narrative table).
function referenceRangeText(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  const rr = asArray(obs?.referenceRange)[0];
  const or = asArray(rr?.observationRange)[0];
  if (!or) return null;
  const val = Array.isArray(or.value) ? or.value[0] : or.value;
  if (val && (val.low != null || val.high != null)) {
    const num = formatIvlPq(val);
    if (num) return num;
  }
  const txt =
    resolveNarrativeText(or.text, narrativeIds) || textOf(val) || null;
  return txt?.trim() || null;
}

// The reading's own abnormal flag from its <interpretationCode> (HL7
// ObservationInterpretation, codeSystem 2.16.840.1.113883.5.83): N→normal, the L*
// family (L/LL/LX) → low, H* (H/HH/HX) → high, A*/other-abnormal → abnormal.
// Susceptibility/other codes (S/R/I/…) don't map to an out-of-range flag → null.
function interpretationFlag(obs: any): MedicalFlag | null {
  for (const ic of asArray(obs?.interpretationCode)) {
    const code = String(ic?.["@_code"] ?? "")
      .trim()
      .toUpperCase();
    if (!code) continue;
    if (code === "N") return "normal";
    if (code.startsWith("L")) return "low";
    if (code.startsWith("H")) return "high";
    if (code.startsWith("A")) return "abnormal";
  }
  return null;
}

// Whether an observation node declares a C-CDA assessment-scale template — the
// instrument itself (4.69) or one of its answered ITEMS (4.86). Exported so the drop
// classifier reads the same signal the mapper routes on.
export function isAssessmentScaleObs(obs: any): boolean {
  return asArray(obs?.templateId).some((t: any) =>
    isAssessmentScaleTemplate(t?.["@_root"])
  );
}

// The SECTION-level class an observation walk starts from. `assessment` is not a
// section shape but a CLASS (#2318): the Functional Status section declares it for
// everything it carries, and the Results walk can promote an individual observation
// into it (see the routing block in mapObservation).
export type ObservationClass = "lab" | "vitals" | "assessment";

// Map a lab / vital-sign / assessment <observation> to an ImportedRecord.
// `narrativeIds` is the section's <text> id→text index (built once per section),
// so an observation whose printed name lives only in the narrative table — reached
// via <text><reference value="#id"/> — resolves instead of falling back to
// "Result".
export function mapObservation(
  obs: any,
  category: ObservationClass,
  narrativeIds: Record<string, string> = {},
  // The performing org resolved off the parent organizer, used when the
  // observation itself carries no <performer> (Epic puts it at either level).
  fallbackProvider: ImportedProvider | null = null
): ImportedRecord | null {
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  // The source time at ITS OWN grain (#2243): `date` is the day the document stated
  // (never shifted by the offset — #94), `occurred_at` the absolute moment, which is
  // null unless the document stated both a clock time and a zone.
  const time = effTime(obs.effectiveTime);
  const date = sourceDay(time);
  if (!date) return null;
  const code = obs.code;
  // LOINC may be the top-level coding, a <translation> child, or flagged only by
  // codeSystemName — extract from wherever it lives so distinct analytes get a
  // stable identity and (for known codes) a canonical destination.
  const loinc = loincFromCode(code);
  // Drop non-analyte administrative rows (specimen dates, "Approved By", accession
  // numbers, …) Epic packs into the Results section — they are annotations on a
  // result, not measurements (#681) — and derived anthropometric percentiles
  // (BMI/weight-for-length/head-circ percentile), which the app recomputes from the
  // raw measurements rather than importing as range-less lab rows.
  if (isNonAnalyteLoinc(loinc) || isDerivedPercentileLoinc(loinc)) return null;
  const canonicalName = canonicalBiomarkerForLoinc(loinc);
  // Name resolution order:
  //   1. structured @_displayName on the code, then
  //   2. the code's <originalText> — for Epic MyChart the analyte name is inline
  //      text here (alongside a child <reference>), e.g.
  //      <originalText>White Blood Cell Count<reference value="#..."/></originalText>;
  //      textOf reads that #text. If originalText is instead a bare <reference>,
  //      resolveNarrativeText follows it into the section narrative table. Then
  //   3. the observation's <text><reference> into the narrative table (+ any
  //      inline obs.text), then
  //   4. the displayName off a LOINC <translation>, then
  //   5. the LOINC canonical name, and only THEN
  //   6. the literal "Result".
  const resolvedName =
    code?.["@_displayName"] ||
    resolveNarrativeText(code?.originalText, narrativeIds) ||
    resolveNarrativeText(obs?.text, narrativeIds) ||
    loincDisplayName(code) ||
    canonicalName ||
    null;
  const name = resolvedName || "Result";
  // A vaccine's LOT NUMBER or EXPIRY filed as a free-standing observation (#2318):
  // it is an attribute of the immunization ENTRY, which has its own store and
  // already carries the lot as provenance. Refused outright — emitting a
  // `ccda:obs:` record for it is what let a manufacturer string coin an analyte
  // name. Checked on the printed label, which is all these rows carry.
  if (isImmunizationAttributeLabel(name)) return null;
  const { value, value_num, unit: valueUnit } = readValue(obs.value);
  // Unit is on the numeric value when present, else on a COMP "units" component
  // (Epic ships many results this way).
  const unit = valueUnit ?? unitFromEntryRelationships(obs);
  // ── The DURATION door (#2322) ───────────────────────────────────────────────
  // A stress test's `Exercise Duration` arrives with the unit `min:sec` and a
  // colon-formatted value. Read at the SOURCE's grain (the raw <value> attributes,
  // because a non-numeric PQ leaves readValue with nothing) and narrowed to the one
  // number + one unit the destination declares — see lib/duration-value.ts. A value
  // the declared unit cannot explain is DROPPED with a reason rather than stored as a
  // string that looks like a reading; the drop is reported as `unparsable_value`.
  const rawPq = rawQuantity(obs.value);
  const duration = normalizeDurationValue(
    value ?? rawPq.text,
    value_num,
    unit ?? rawPq.unit
  );
  if (duration.kind === "unparsable") return null;
  const resolved =
    duration.kind === "normalized"
      ? {
          value: duration.value,
          value_num: duration.value_num,
          unit: duration.unit,
        }
      : { value, value_num, unit };
  // Drop noise: an observation with no productive value carries nothing to
  // record — whether it's a nameless "Result.Type" marker or a named-but-empty
  // row like Epic's "Comment(s)" (LOINC 8251-1, <value nullFlavor="NA"/>, which
  // the app would otherwise surface as an empty "—"). Qualitative results keep a
  // string value, so "Positive"/"Detected"/etc. survive.
  if (resolved.value == null && resolved.value_num == null) return null;
  // The reading's own stated range, read ONCE: it is both a stored field (labs only)
  // and one of the four facts the assessment/qualifier routing below asks about.
  const sourceRange = referenceRangeText(obs, narrativeIds);
  // ── What CLASS of row is this? (#2318) ──────────────────────────────────────
  // `assessment` wins first. The Functional Status section declares it for
  // everything it carries; a Results-section observation is PROMOTED into it when it
  // states no measurement and claims no analyte identity (isNonAnalyteObservation) —
  // a temperature's body site, a questionnaire item's free-text answer, a generic
  // status word. This also subsumes the #694 rule the old `allowCategoryOverride`
  // flag encoded: an assessment reusing a VITAL_LOINCS code is still an assessment,
  // because the class is decided before the vital-code override is even consulted.
  //
  // Then the #681 override: a vital-sign LOINC that arrives in a lab/results section
  // — Epic reports body weight and BMI there — is still a vital, classified by the
  // code, not the section. Mirrors how the FHIR path routes off isVitalLoinc.
  const isAssessment =
    category === "assessment" ||
    (category === "lab" &&
      isNonAnalyteObservation({
        loinc,
        valueNum: resolved.value_num,
        unit: resolved.unit,
        referenceRange: sourceRange,
        assessmentScale: isAssessmentScaleObs(obs),
      }));
  const recordCategory: ObservationClass = isAssessment
    ? "assessment"
    : isVitalLoinc(loinc)
      ? "vitals"
      : category;
  // Resolve to a canonical biomarker name by LOINC when one exists, so the
  // reading groups with the same concept elsewhere in the app; otherwise keep
  // the printed name.
  const canonical = canonicalName ?? String(name);
  // The dedup key carries the AS-SHIPPED value (captured before any unit
  // normalization below), so a reading's identity is stable across normalization
  // changes — a re-import of a document whose Celsius reading was stored
  // pre-conversion (#1018) matches the existing row instead of duplicating it.
  // NOTE (#2318): an `assessment` keeps the `obs` prefix a `lab` had, so re-importing
  // a document whose rows were stored (and then re-categorised by migration 177)
  // BEFORE this classification existed still dedupes onto them instead of duplicating.
  // (The raw PQ text is the last fallback so a duration the door just recovered gets a
  // distinguishing key — before #2322 such a row had no value at all and was dropped,
  // so no already-stored external_id can shift under this.)
  const external_id = `ccda:${recordCategory === "vitals" ? "vital" : "obs"}:${String(
    loinc || name
  ).toLowerCase()}:${date}:${value_num ?? value ?? rawPq.text ?? ""}`;
  // Body Temperature converts to canonical °F at the import boundary (#1018), the
  // same conversion every live-entry writer performs — a MyChart "38.5 Cel" must
  // join the series as 101.3 degF, not as an unconvertible verbatim row that never
  // charts or flags. Recognized spellings only (UCUM Cel/[degF], °C/°F, text
  // forms); an unrecognized unit or an implausible converted value stays verbatim
  // (the heightToCm skip-don't-guess posture).
  let stored = resolved;
  if (canonical === VITAL_CANONICAL.temperature.canonical) {
    stored =
      normalizeImportedTemperature(resolved.value_num, resolved.unit) ?? stored;
  }
  // The lab's own range + interpretation (#761 follow-up), captured on labs only —
  // vitals keep their dedicated flag engines, and an assessment has no band to be
  // in or out of (the Functional Status section can print one; it describes the
  // instrument, not a measurement).
  const reference_range = recordCategory === "lab" ? sourceRange : null;
  const flag = recordCategory === "lab" ? interpretationFlag(obs) : null;
  return {
    category: recordCategory,
    name: String(name),
    canonical,
    value: stored.value,
    value_num: stored.value_num,
    unit: stored.unit,
    date,
    occurred_at: sourceInstant(time),
    loinc: loinc ?? null,
    reference_range,
    flag,
    // Include the value in the dedup key: two distinct same-day observations that
    // share a code/name (or fall back to the same "Result" name with no LOINC)
    // would otherwise collapse to one external_id and dedupe() would drop a real
    // reading. A genuine duplicate (same value) still dedupes.
    external_id,
    // The performing lab/org (e.g. "QUEST") — from the observation's own
    // <performer>, else the organizer's.
    provider: providerFromPerformer(obs) ?? fallbackProvider,
  };
}

// ── Whose screening is this? (#2321) ────────────────────────────────────────
//
// A C-CDA clinical statement may name a subject other than the record target with a
// `<subject><relatedSubject>` participation — the shape Family History already reads
// for the affected relative. A perinatal screening administered to a PARENT and filed
// in the CHILD's chart is the case that matters: attributing that depression score to
// the child would be wrong clinically, wrong under this app's profile model, and would
// put a crisis-escalating score on the wrong person.
//
// So this reports what the document SAYS, and never infers. `relatedSubject
// classCode="PAT"` is the chart's own patient; any other relatedSubject is somebody
// else; no statement at all is `unstated` — which the recognizer refuses just as it
// refuses a stated other, because a screening score that cannot be attributed is worse
// unimported than misfiled.
const PATIENT_SUBJECT_CLASS = "PAT";

function subjectOfNode(node: any): InstrumentSubject | null {
  const rel = node?.subject?.relatedSubject;
  if (rel == null) return null;
  const cls = String(rel?.["@_classCode"] ?? "")
    .trim()
    .toUpperCase();
  return cls === PATIENT_SUBJECT_CLASS ? "patient" : "other";
}

// The subject the section's entries state, scanning the section node, each entry's
// organizer and each observation. A stated OTHER wins over a stated patient: if any
// part of the screening names a different subject, the screening is not the patient's.
export function statedInstrumentSubject(
  sectionNode: any,
  entries: any[]
): InstrumentSubject {
  const nodes: any[] = [sectionNode];
  for (const entry of entries) {
    nodes.push(entry, entry?.organizer);
    nodes.push(
      ...asArray(entry?.organizer?.component).map((c: any) => c?.observation)
    );
    nodes.push(...asArray(entry?.observation));
  }
  let seen: InstrumentSubject = "unstated";
  for (const n of nodes) {
    const v = subjectOfNode(n);
    if (v === "other") return "other";
    if (v === "patient") seen = "patient";
  }
  return seen;
}

function observationsFromEntries(
  entries: any[],
  category: ObservationClass,
  narrativeIds: Record<string, string> = {}
): ImportedRecord[] {
  const out: ImportedRecord[] = [];
  for (const entry of entries) {
    // Usually organizer → component → observation; sometimes a bare observation.
    // The performing org often rides the organizer (once per panel) rather than
    // each observation, so resolve it once and pass it as the fallback.
    const orgProvider = providerFromPerformer(entry?.organizer);
    const nested = asArray(entry?.organizer?.component).map(
      (c: any) => c?.observation
    );
    for (const o of [...nested, ...asArray(entry?.observation)]) {
      // A radiology-study observation carries no lab value (its structured
      // modality/site route to imaging_studies below) — never a lab record.
      if (isRadiologyStudyObs(o)) continue;
      // A narrative report observation (ED-valued culture/gram-stain/cytology) routes
      // to a `report` record below — never a (null-value) lab.
      if (isReportNarrativeObs(o)) continue;
      const rec = mapObservation(o, category, narrativeIds, orgProvider);
      if (rec) out.push(rec);
    }
  }
  return out;
}

// ── Shared narrative helpers (imaging impressions + report bodies) ──────────
// Cap a stored narrative so a pathological blob can't bloat a row; real impressions /
// culture bodies run a few hundred to a couple thousand chars. Matches the
// notes-length posture of the AI extract path.
const NARRATIVE_MAX = 8000;

// Strip a leading/trailing "rule line" — a run of separator chars + whitespace that
// renders as ugly "-----" noise and carries no content (a real report never opens or
// closes on a rule). A SINGLE character class `[-_=\s]+` (linear, no nested quantifier
// — the `(?:\s*[-_=]{2,}\s*)+` shape it replaces was catastrophic-backtracking ReDoS on
// dash+space padded radiology narratives) grabs the leading/trailing run; it's only
// dropped when it actually contains a 2+ separator run, so a single "- " list bullet
// survives.
const stripEdgeRule = (text: string): string =>
  text
    .replace(/^[-_=\s]+/, (m) => (/[-_=]{2,}/.test(m) ? "" : m))
    .replace(/[-_=\s]+$/, (m) => (/[-_=]{2,}/.test(m) ? "" : m));

function capNarrative(text: string): string {
  const trimmed = stripEdgeRule(text).trim();
  return trimmed.length > NARRATIVE_MAX
    ? trimmed.slice(0, NARRATIVE_MAX).trimEnd() + "…"
    : trimmed;
}

// The observation's <value> node when it is encapsulated data (ED) — the narrative
// report / report-component shape — else null. removeNSPrefix turns xsi:type into the
// bare @_type.
function edValue(obs: any): any | null {
  const v = Array.isArray(obs?.value) ? obs.value[0] : obs?.value;
  return v?.["@_type"] === "ED" ? v : null;
}

// ── Radiology study observations → imaging_studies (CDA) ────────────────────
// Epic ships a radiology study as a Result Observation coded LOINC 18782-3
// "Radiology Study observation (narrative)". The <value> is nullFlavor'd (the report
// body isn't inline), but it carries a STRUCTURED methodCode (modality — "Ultrasound"),
// targetSiteCode (body region — "Breast") + a laterality qualifier ("left") and an
// effectiveTime. The FHIR path already maps an ImagingStudy resource to
// ImportedImagingStudy; this recovers the SAME study event from a CDA Results section
// (previously dropped as a null-value lab), reusing the shared modality/laterality
// normalizers. The radiologist's IMPRESSION is folded in from the study's report-prose
// siblings (see impressionFromSiblings); the persist layer writes it exactly like the
// FHIR path (imaging_studies is already in the import footprint).
const RADIOLOGY_STUDY_LOINC = "18782-3";

export function isRadiologyStudyObs(obs: any): boolean {
  return obs?.code?.["@_code"] === RADIOLOGY_STUDY_LOINC;
}

// The printed human label — <originalText> text, else the coding's displayName. Epic
// puts "Ultrasound"/"Breast"/"left" in <originalText> with an Epic-local code system
// the normalizers can't read, so the text is the signal.
function codedLabel(node: any): string | null {
  const ot = textOf(node?.originalText)?.trim();
  if (ot) return ot;
  const dn = node?.["@_displayName"];
  return typeof dn === "string" && dn.trim() ? dn.trim() : null;
}

// SNOMED CT "Laterality" (qualifier-value hierarchy) — the <name code> that marks a
// targetSiteCode <qualifier> as the LATERALITY qualifier specifically.
const SNOMED_LATERALITY = "272741003";

// A C-CDA <targetSiteCode> can legally carry several <qualifier> entries (a
// view/approach/orientation qualifier alongside laterality), in any order. Pick the
// one whose <name> is SNOMED 272741003 (Laterality) rather than array position (#1366)
// — matching how the file's other coded extractions key off the qualifying code, not
// the slot — so a study whose first qualifier is a non-laterality view/projection still
// recovers its stated laterality instead of silently dropping it.
function lateralityQualifier(targetSiteCode: any): any | undefined {
  return asArray(targetSiteCode?.qualifier).find(
    (q) => q?.name?.["@_code"] === SNOMED_LATERALITY
  );
}

function firstObsIdExt(obs: any): string | null {
  for (const id of asArray(obs?.id)) {
    if (id?.["@_nullFlavor"] != null) continue;
    const ext = String(id?.["@_extension"] ?? "").trim();
    if (ext) return ext;
  }
  return null;
}

function mapImagingStudy(obs: any): ImportedImagingStudy | null {
  if (!isRadiologyStudyObs(obs) || truthyNegation(obs?.["@_negationInd"]))
    return null;
  const { start } = hl7Period(obs?.effectiveTime);
  const date = sourceDay(start ?? effTime(obs?.effectiveTime));
  const idExt = firstObsIdExt(obs);
  // Nothing to key on → can't dedup a re-import, so drop rather than mint an
  // unstable row.
  if (!date && !idExt) return null;
  const modality = normalizeModality(codedLabel(obs?.methodCode));
  const site = codedLabel(obs?.targetSiteCode);
  const laterality = normalizeLaterality(
    codedLabel(lateralityQualifier(obs?.targetSiteCode)?.value)
  );
  return {
    modality,
    body_region: site,
    laterality,
    contrast: false,
    contrast_agent: null,
    study_date: date,
    dose_msv: null,
    impression: null,
    indication: null,
    status: obs?.statusCode?.["@_code"] ?? null,
    external_id: idExt
      ? `ccda:imaging:${idExt}`
      : `ccda:imaging:${date}:${modality}:${(site ?? "").toLowerCase()}`,
  };
}

// ── Radiology report prose → the study's impression (CDA, #708 follow-up) ────
// Epic packs a radiology report's prose into sibling observations of the study's
// organizer (code 38026-1), each a nullFlavor-LOINC observation whose only code is an
// Epic.ResultText translation — IMP (impression), NAR (narrative), PXN (procedure
// note), ADD (addendum) — with an ED value referencing the narrative table. The study
// observation's own <value> is nullFlavor, so its impression is recovered from these
// siblings, preferring the radiologist's IMPRESSION, then the fuller narrative. (Each
// radiology organizer holds exactly one study + its prose, so the impression can't
// cross-assign.) These siblings are NOT captured as `report` records — they have no
// real report LOINC — so this is their one home.
const EPIC_RESULT_TEXT_OID = "1.2.840.114350.1.72.1.5220";
const IMPRESSION_CODE_PRIORITY = ["IMP", "NAR", "PXN", "ADD"];

function epicResultTextCode(obs: any): string | null {
  for (const tr of asArray(obs?.code?.translation)) {
    const isEpicResultText =
      tr?.["@_codeSystem"] === EPIC_RESULT_TEXT_OID ||
      tr?.["@_codeSystemName"] === "Epic.ResultText";
    const code = tr?.["@_code"];
    if (isEpicResultText && typeof code === "string" && code) return code;
  }
  return null;
}

function impressionFromSiblings(
  observations: any[],
  blocks: Record<string, string>
): string | null {
  const byCode = new Map<string, string>();
  for (const o of observations) {
    const code = epicResultTextCode(o);
    if (!code || byCode.has(code)) continue;
    const val = edValue(o);
    if (!val) continue;
    // Block map so a multi-line impression keeps its line breaks.
    const text = resolveNarrativeText(val, blocks);
    if (text && text.trim()) byCode.set(code, text.trim());
  }
  for (const code of IMPRESSION_CODE_PRIORITY) {
    const t = byCode.get(code);
    if (t) return capNarrative(t);
  }
  return null;
}

// Deep-walk a Results section's entries for radiology-study observations (the SAME
// organizer→component / bare-observation shape observationsFromEntries reads),
// recovering each study's impression from its organizer's report-prose siblings.
function imagingStudiesFromEntries(
  entries: any[],
  blocks: Record<string, string>
): ImportedImagingStudy[] {
  const out: ImportedImagingStudy[] = [];
  for (const entry of entries) {
    const orgObs = asArray(entry?.organizer?.component)
      .map((c: any) => c?.observation)
      .filter(Boolean);
    // The impression is resolved once per organizer, so it attaches to the organizer's
    // one study and never bleeds to a study in another entry.
    const orgImpression = impressionFromSiblings(orgObs, blocks);
    for (const o of orgObs) {
      const study = mapImagingStudy(o);
      if (study) out.push({ ...study, impression: orgImpression });
    }
    // A bare (organizer-less) study carries no sibling prose — impression stays null.
    for (const o of asArray(entry?.observation)) {
      const study = mapImagingStudy(o);
      if (study) out.push(study);
    }
  }
  return out;
}

// ── Narrative diagnostic reports → `report` records (CDA, #708) ──────────────
// A microbiology culture / gram stain / cytopathology report ships as a Result
// Observation whose <value> is encapsulated data — `xsi:type="ED"` (→ @_type after
// removeNSPrefix) — pointing at the report body in the section's narrative <table>
// via <reference value="#id"/>. readValue can't extract an ED reference, so these were
// previously dropped as null-value labs. This recovers the report body: the ED
// reference is resolved into narrative text and stored as a `report` medical_records
// row (text in `notes`, value/value_num NULL) — a dated document, never a trending
// analyte. It surfaces on Results → Reports.
//
// SCOPE: we require a resolvable LOINC on the observation (e.g. 34574-4 "Final Report",
// 11502-2 microbiology/lab report, 33718-8 cytology). An ED-valued obs with only an
// Epic-proprietary Result.Text code (nullFlavor LOINC — the ADD/IMP/NAR/PXN radiology
// report components) is left out here: those are the radiology narrative, whose event
// is the imaging_studies row above and whose prose is folded into THAT study's
// impression (impressionFromSiblings), not a standalone report.

// A narrative report observation: an ED-valued result carrying a real LOINC (so it has
// a report identity/name and isn't an Epic-proprietary radiology component). Exported
// so the lab walker and the coverage report both treat it as consumed, not dropped.
export function isReportNarrativeObs(obs: any): boolean {
  return edValue(obs) != null && loincFromCode(obs?.code) != null;
}

function mapClinicalReport(
  obs: any,
  // Collapsed map resolves the single-line NAME; block map keeps the BODY's line breaks.
  names: Record<string, string>,
  blocks: Record<string, string>,
  fallbackProvider: ImportedProvider | null
): ImportedRecord | null {
  const val = edValue(obs);
  if (!val || truthyNegation(obs?.["@_negationInd"])) return null;
  if (!isReportNarrativeObs(obs)) return null;
  const time = effTime(obs.effectiveTime);
  const date = sourceDay(time);
  // A record row is date-anchored (medical_records.date is NOT NULL) and a report with
  // no body carries nothing to store — drop rather than mint an empty row.
  if (!date) return null;
  const body = resolveNarrativeText(val, blocks);
  if (!body || !body.trim()) return null;
  const loinc = loincFromCode(obs.code);
  const code = obs.code;
  // Name: the printed report label (originalText / displayName), else the LOINC's
  // display, else a generic "Report".
  const name =
    resolveNarrativeText(code?.originalText, names) ||
    code?.["@_displayName"] ||
    loincDisplayName(code) ||
    "Report";
  const idExt = firstObsIdExt(obs);
  return {
    category: "report",
    name: String(name),
    // Report rows don't group as analytes; keep the printed name as the canonical
    // (never registered as a biomarker — the persist layer filters registration to
    // `lab` records only).
    canonical: String(name),
    value: null,
    value_num: null,
    unit: null,
    date,
    occurred_at: sourceInstant(time),
    loinc: loinc ?? null,
    notes: capNarrative(body.trim()),
    external_id: idExt
      ? `ccda:report:${idExt}`
      : `ccda:report:${date}:${loinc}`,
    provider: providerFromPerformer(obs) ?? fallbackProvider,
  };
}

// Deep-walk a Results section's entries for narrative report observations (the SAME
// organizer→component / bare-observation shape observationsFromEntries reads). The
// performing lab/pathologist often rides the organizer, so resolve it once as the
// fallback, exactly like the lab walker.
function reportRecordsFromEntries(
  entries: any[],
  names: Record<string, string>,
  blocks: Record<string, string>
): ImportedRecord[] {
  const out: ImportedRecord[] = [];
  for (const entry of entries) {
    const orgProvider = providerFromPerformer(entry?.organizer);
    const nested = asArray(entry?.organizer?.component).map(
      (c: any) => c?.observation
    );
    for (const o of [...nested, ...asArray(entry?.observation)]) {
      const rec = mapClinicalReport(o, names, blocks, orgProvider);
      if (rec) out.push(rec);
    }
  }
  return out;
}

// A section's screening instrument, folded out of its per-question rows (#2321). The
// SAME call in every section that carries assessment rows, so which section an EHR
// files a screening in — Results or Functional Status — cannot change whether it
// scores. `foldInstrumentScores` is a no-op for a section that spells out no
// instrument, which is nearly all of them.
function withInstrumentScores(
  section: CdaSection,
  records: ImportedRecord[]
): { records: ImportedRecord[]; drops: ImportDrop[] } {
  return foldInstrumentScores(
    records,
    statedInstrumentSubject(section.raw, section.entries),
    sectionTitleOf(section)
  );
}

// The section's printed title, for a drop's context line.
function sectionTitleOf(section: CdaSection): string {
  const t = textOf(section.raw?.title);
  return t?.trim() || "Results";
}

export const labResultsExtractor: SectionExtractor = {
  key: "results",
  matches: (s) => sectionIs(s, SECTIONS.results),
  extract: (s) => {
    // Two shapes of the same narrative: the block map for multi-line report BODIES +
    // radiology impressions (#708), the collapsed map for single-line lab/report NAMES.
    // Build the block map with ONE tree walk and derive the collapsed map from it (a
    // cheap per-value string collapse) — the collectText walk over a big report table
    // is superlinear, so it must not be paid twice.
    const narrativeBlocks = buildNarrativeBlockMap(s.raw?.text);
    const narrativeIds = collapseNarrativeMap(narrativeBlocks);
    const folded = withInstrumentScores(s, [
      ...observationsFromEntries(s.entries, "lab", narrativeIds),
      ...reportRecordsFromEntries(s.entries, narrativeIds, narrativeBlocks),
    ]);
    return {
      records: folded.records,
      drops: folded.drops,
      imagingStudies: imagingStudiesFromEntries(s.entries, narrativeBlocks),
    };
  },
};

export const vitalSignsExtractor: SectionExtractor = {
  key: "vitals",
  matches: (s) => sectionIs(s, SECTIONS.vitals),
  extract: (s) => ({
    records: observationsFromEntries(
      s.entries,
      "vitals",
      buildNarrativeIdMap(s.raw?.text)
    ),
  }),
};

// Functional Status (#268): assessment observations ("ambulates independently",
// ADL/IADL findings, the body SITE a temperature was taken at, …) carried as
// organizer→component or bare observations — the SAME node shapes the Results
// walker reads, with coded (qualitative) or numeric values, so they route through
// the shared observation mapper.
//
// The assessment LOINC is stripped from the STORED record (after the mapper has
// used it for the name fallback and the stable external_id): these are assessment
// instruments, not lab analytes, so carrying the code forward would list every
// functional-status code in the "Unmapped lab codes" report — inviting canonical
// biomarker-map additions that would be wrong — and could misroute a coded
// assessment through the LOINC-keyed vitals/height recognizers.
//
// That reasoning was right, and it is why the section's class is now `assessment`
// rather than `lab` (#2318). The strip guarded the CODE axis only; identity also
// runs on the NAME, so the same rows still registered a canonical name, still
// became Coverage candidates, and still drew bandless series — the very outcome
// the strip exists to prevent, one surface over. The class carries the guard on
// BOTH axes, and it subsumes the #694 rule too: an assessment reusing a
// VITAL_LOINCS code can no longer flip to "vitals", because mapObservation decides
// `assessment` before the vital-code override is consulted.
export const functionalStatusExtractor: SectionExtractor = {
  key: "functionalStatus",
  matches: (s) => sectionIs(s, SECTIONS.functionalStatus),
  extract: (s) =>
    withInstrumentScores(
      s,
      observationsFromEntries(
        s.entries,
        "assessment",
        buildNarrativeIdMap(s.raw?.text)
      ).map((r) => ({ ...r, loinc: null }))
    ),
};
