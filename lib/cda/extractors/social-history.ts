// CDA section extractors — social history. Sex-at-birth derivation, the smoking
// -status-to-condition mapping, and the social-history section extractor.
import type { ImportedCondition } from "../../health-import";
import {
  normalizeSmokingStatus,
  normalizeSocialSex,
  smokingConditionExternalId,
} from "../../social-history";
import type { Sex } from "../../types";
import {
  SECTIONS,
  SEX_AT_BIRTH_LOINC,
  SEX_LOINC,
  SMOKING_STATUS_LOINC,
} from "../constants";
import type { CdaSection, SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  codeSystemLabel,
  codedValueOf,
  loincFromCode,
  sectionIs,
  truthyNegation,
} from "../normalize";

// The patient's sex as coded in a document's Social History section, or null. Sex
// assigned at birth (76689-9) is preferred over the administrative Sex (46098-0)
// when both carry a usable value — it's the biologically-relevant signal for the
// sex-banded biomarker ranges — with either falling back to the other. Used only to
// ENRICH the header demographics (mapDemographics) when the header states no sex; it
// never overrides one, and profile seeding stays only-when-unset downstream.
export function socialHistorySex(sections: CdaSection[]): Sex | null {
  let atBirth: Sex | null = null;
  let legal: Sex | null = null;
  for (const s of sections) {
    if (!sectionIs(s, SECTIONS.socialHistory)) continue;
    const ids = buildNarrativeIdMap(s.raw?.text);
    for (const entry of s.entries) {
      const obs = entry?.observation;
      if (!obs || truthyNegation(obs["@_negationInd"])) continue;
      const loinc = loincFromCode(obs.code);
      if (loinc !== SEX_AT_BIRTH_LOINC && loinc !== SEX_LOINC) continue;
      const sex = normalizeSocialSex(codedValueOf(obs.value, ids));
      if (!sex) continue;
      if (loinc === SEX_AT_BIRTH_LOINC) atBirth ??= sex;
      else legal ??= sex;
    }
  }
  return atBirth ?? legal;
}

// The tobacco smoking status (72166-2) captured as social-history condition rows —
// one per informative status observation (a "consumption unknown" / nullFlavor'd
// value yields none; see normalizeSmokingStatus). Stored in the conditions table
// (no new surface): name is the coded status display ("Former smoker"), code the
// SNOMED code, status 'active' as a current documented finding. onset_date is left
// null — the observation's effectiveTime is the assessment date, not a true onset.
function smokingConditionsFromSection(
  section: CdaSection
): ImportedCondition[] {
  const ids = buildNarrativeIdMap(section.raw?.text);
  const out: ImportedCondition[] = [];
  for (const entry of section.entries) {
    const obs = entry?.observation;
    if (!obs || truthyNegation(obs["@_negationInd"])) continue;
    const loinc = loincFromCode(obs.code);
    const tids = asArray(obs?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    const isSmoking =
      loinc === SMOKING_STATUS_LOINC ||
      tids.includes("2.16.840.1.113883.10.20.22.4.78");
    if (!isSmoking) continue;
    const cv = codedValueOf(obs.value, ids);
    const status = normalizeSmokingStatus(cv);
    if (!status) continue;
    out.push({
      name: status.display,
      code: status.code,
      code_system: status.code ? codeSystemLabel(cv?.codeSystem) : null,
      status: "active",
      onset_date: null,
      resolved_date: null,
      external_id: smokingConditionExternalId(status),
    });
  }
  return out;
}

// ---- built-in extractors ----

// Social History: the smoking status becomes a condition row; the
// section's coded sex is read separately (socialHistorySex) to enrich demographics.
export const socialHistoryExtractor: SectionExtractor = {
  key: "socialHistory",
  matches: (s) => sectionIs(s, SECTIONS.socialHistory),
  extract: (s) => ({ conditions: smokingConditionsFromSection(s) }),
};
