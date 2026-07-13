// CDA section extractors — observations (lab results, vital signs, functional
// status). The shared observation mapper plus the result/vitals/functional-status
// section extractors.
import {
  canonicalBiomarkerForLoinc,
  isNonAnalyteLoinc,
  isVitalLoinc,
} from "../../biomarker-loinc";
import type { ImportedProvider, ImportedRecord } from "../../health-import";
import { SECTIONS } from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  effTime,
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
  fallbackProvider: ImportedProvider | null = null
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
  // result, not measurements (#681).
  if (isNonAnalyteLoinc(loinc)) return null;
  // A vital-sign LOINC that arrives in a lab/results section — Epic reports body
  // weight and BMI there — is still a vital: classify by the code, not the section
  // (#681). Mirrors how the FHIR path routes category off isVitalLoinc.
  const recordCategory: "lab" | "vitals" = isVitalLoinc(loinc)
    ? "vitals"
    : category;
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
  return {
    category: recordCategory,
    name: String(name),
    canonical,
    value,
    value_num,
    unit,
    date,
    loinc: loinc ?? null,
    // Include the value in the dedup key: two distinct same-day observations that
    // share a code/name (or fall back to the same "Result" name with no LOINC)
    // would otherwise collapse to one external_id and dedupe() would drop a real
    // reading. A genuine duplicate (same value) still dedupes.
    external_id: `ccda:${recordCategory === "vitals" ? "vital" : "obs"}:${String(
      loinc || name
    ).toLowerCase()}:${date}:${value_num ?? value ?? ""}`,
    // The performing lab/org (e.g. "QUEST") — from the observation's own
    // <performer>, else the organizer's.
    provider: providerFromPerformer(obs) ?? fallbackProvider,
  };
}

function observationsFromEntries(
  entries: any[],
  category: "lab" | "vitals",
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
      const rec = mapObservation(o, category, narrativeIds, orgProvider);
      if (rec) out.push(rec);
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
    records: observationsFromEntries(
      s.entries,
      "lab",
      buildNarrativeIdMap(s.raw?.text)
    ).map((r) => ({ ...r, loinc: null })),
  }),
};
