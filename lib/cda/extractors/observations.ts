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
import { normalizeLaterality, normalizeModality } from "../../imaging-study";
import {
  VITAL_CANONICAL,
  normalizeImportedTemperature,
} from "../../vitals-input";
import { SECTIONS } from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  effTime,
  hl7Period,
  loincDisplayName,
  loincFromCode,
  providerFromPerformer,
  readValue,
  resolveNarrativeText,
  sectionIs,
  textOf,
  truthyNegation,
  unitFromEntryRelationships,
} from "../normalize";

// Map a lab / vital-sign <observation> to an ImportedRecord of `category`.
// `narrativeIds` is the section's <text> id→text index (built once per section),
// so an observation whose printed name lives only in the narrative table — reached
// via <text><reference value="#id"/> — resolves instead of falling back to
// "Result".
export function mapObservation(
  obs: any,
  category: "lab" | "vitals",
  narrativeIds: Record<string, string> = {},
  // The performing org resolved off the parent organizer, used when the
  // observation itself carries no <performer> (Epic puts it at either level).
  fallbackProvider: ImportedProvider | null = null,
  // Whether a vital-sign LOINC may override the section's category to "vitals".
  // True for the Results/Vitals extractors (Epic files body weight/BMI/height under
  // Results, and they ARE vitals — #681). False for the functionalStatusExtractor:
  // a functional-status assessment that happens to reuse a VITAL_LOINCS code must
  // stay a `lab` assessment, not become a "vitals" record (#694) — its own extractor
  // nulls the loinc AFTER mapping, too late to undo a category override.
  allowCategoryOverride = true
): ImportedRecord | null {
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const date = effTime(obs.effectiveTime);
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
  // A vital-sign LOINC that arrives in a lab/results section — Epic reports body
  // weight and BMI there — is still a vital: classify by the code, not the section
  // (#681). Mirrors how the FHIR path routes category off isVitalLoinc. Gated by
  // allowCategoryOverride so a functional-status assessment reusing a vital LOINC is
  // NOT reclassified (#694).
  const recordCategory: "lab" | "vitals" =
    allowCategoryOverride && isVitalLoinc(loinc) ? "vitals" : category;
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
  const { value, value_num, unit: valueUnit } = readValue(obs.value);
  // Unit is on the numeric value when present, else on a COMP "units" component
  // (Epic ships many results this way).
  const unit = valueUnit ?? unitFromEntryRelationships(obs);
  // Drop noise: an observation with no productive value carries nothing to
  // record — whether it's a nameless "Result.Type" marker or a named-but-empty
  // row like Epic's "Comment(s)" (LOINC 8251-1, <value nullFlavor="NA"/>, which
  // the app would otherwise surface as an empty "—"). Qualitative results keep a
  // string value, so "Positive"/"Detected"/etc. survive.
  if (value == null && value_num == null) return null;
  // Resolve to a canonical biomarker name by LOINC when one exists, so the
  // reading groups with the same concept elsewhere in the app; otherwise keep
  // the printed name.
  const canonical = canonicalName ?? String(name);
  // The dedup key carries the AS-SHIPPED value (captured before any unit
  // normalization below), so a reading's identity is stable across normalization
  // changes — a re-import of a document whose Celsius reading was stored
  // pre-conversion (#1018) matches the existing row instead of duplicating it.
  const external_id = `ccda:${recordCategory === "vitals" ? "vital" : "obs"}:${String(
    loinc || name
  ).toLowerCase()}:${date}:${value_num ?? value ?? ""}`;
  // Body Temperature converts to canonical °F at the import boundary (#1018), the
  // same conversion every live-entry writer performs — a MyChart "38.5 Cel" must
  // join the series as 101.3 degF, not as an unconvertible verbatim row that never
  // charts or flags. Recognized spellings only (UCUM Cel/[degF], °C/°F, text
  // forms); an unrecognized unit or an implausible converted value stays verbatim
  // (the heightToCm skip-don't-guess posture).
  let stored = { value, value_num, unit };
  if (canonical === VITAL_CANONICAL.temperature.canonical) {
    stored = normalizeImportedTemperature(value_num, unit) ?? stored;
  }
  return {
    category: recordCategory,
    name: String(name),
    canonical,
    value: stored.value,
    value_num: stored.value_num,
    unit: stored.unit,
    date,
    loinc: loinc ?? null,
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

function observationsFromEntries(
  entries: any[],
  category: "lab" | "vitals",
  narrativeIds: Record<string, string> = {},
  allowCategoryOverride = true
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
      const rec = mapObservation(
        o,
        category,
        narrativeIds,
        orgProvider,
        allowCategoryOverride
      );
      if (rec) out.push(rec);
    }
  }
  return out;
}

// ── Radiology study observations → imaging_studies (CDA) ────────────────────
// Epic ships a radiology study as a Result Observation coded LOINC 18782-3
// "Radiology Study observation (narrative)". The <value> is nullFlavor'd (the report
// body isn't inline), but it carries a STRUCTURED methodCode (modality — "Ultrasound"),
// targetSiteCode (body region — "Breast") + a laterality qualifier ("left") and an
// effectiveTime. The FHIR path already maps an ImagingStudy resource to
// ImportedImagingStudy; this recovers the SAME study event from a CDA Results section
// (previously dropped as a null-value lab), reusing the shared modality/laterality
// normalizers. No inline impression is available, so it lands as a dated
// modality/site/laterality study — the persist layer writes it exactly like the FHIR
// path (imaging_studies is already in the import footprint).
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
  const date = start ?? effTime(obs?.effectiveTime);
  const idExt = firstObsIdExt(obs);
  // Nothing to key on → can't dedup a re-import, so drop rather than mint an
  // unstable row.
  if (!date && !idExt) return null;
  const modality = normalizeModality(codedLabel(obs?.methodCode));
  const site = codedLabel(obs?.targetSiteCode);
  const qualifier = asArray(obs?.targetSiteCode?.qualifier)[0];
  const laterality = normalizeLaterality(codedLabel(qualifier?.value));
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

// Deep-walk a Results section's entries for radiology-study observations (the SAME
// organizer→component / bare-observation shape observationsFromEntries reads).
function imagingStudiesFromEntries(entries: any[]): ImportedImagingStudy[] {
  const out: ImportedImagingStudy[] = [];
  for (const entry of entries) {
    const nested = asArray(entry?.organizer?.component).map(
      (c: any) => c?.observation
    );
    for (const o of [...nested, ...asArray(entry?.observation)]) {
      const study = mapImagingStudy(o);
      if (study) out.push(study);
    }
  }
  return out;
}

export const labResultsExtractor: SectionExtractor = {
  key: "results",
  matches: (s) => sectionIs(s, SECTIONS.results),
  extract: (s) => ({
    records: observationsFromEntries(
      s.entries,
      "lab",
      buildNarrativeIdMap(s.raw?.text)
    ),
    imagingStudies: imagingStudiesFromEntries(s.entries),
  }),
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
// ADL/IADL findings, …) carried as organizer→component or bare observations — the
// SAME node shapes the Results walker reads, with coded (qualitative) or numeric
// values, so they route through the shared observation mapper as `lab` records.
// The assessment LOINC is stripped from the STORED record (after the mapper has
// used it for the name fallback and the stable external_id): these are assessment
// instruments, not lab analytes, so carrying the code forward would list every
// functional-status code in the "Unmapped lab codes" report — inviting canonical
// biomarker-map additions that would be wrong — and could misroute a coded
// assessment through the LOINC-keyed vitals/height recognizers.
export const functionalStatusExtractor: SectionExtractor = {
  key: "functionalStatus",
  matches: (s) => sectionIs(s, SECTIONS.functionalStatus),
  extract: (s) => ({
    // allowCategoryOverride=false: a functional-status assessment reusing a
    // VITAL_LOINCS code must stay a `lab` assessment, never flip to "vitals"
    // (#694) — nulling the loinc below is too late to undo a category override.
    records: observationsFromEntries(
      s.entries,
      "lab",
      buildNarrativeIdMap(s.raw?.text),
      false
    ).map((r) => ({ ...r, loinc: null })),
  }),
};
