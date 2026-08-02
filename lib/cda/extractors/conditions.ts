// CDA section extractors — conditions / problems. The condition mapper and the
// problems + past-illness section extractors.
import {
  conditionExternalId,
  decideImportedConditionStatus,
  isNoKnownProblemText,
  toConditionStatus,
} from "../../clinical-parse";
import {
  toConditionLaterality,
  toConditionSeverity,
} from "../../condition-attributes";
import type { ImportedCondition } from "../../health-import";
import {
  PROBLEM_OBS_TEMPLATE,
  SECTIONS,
  SEVERITY_OBS_TEMPLATE,
} from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  clinicalStatusFromEntryRelationships,
  codedDisplayName,
  effTime,
  hl7Date,
  pickCode,
  resolveNarrativeText,
  sectionIs,
  truthyNegation,
} from "../normalize";

// The problem's SEVERITY (#1403): a nested Severity Observation (template 4.8),
// whose <value> codes the SNOMED mild/moderate/severe grade. Walks
// entryRelationships the way the allergy severity reader does — the same nesting,
// the same template — and returns the display name / code for the shared coercion.
// Null when the document states no grade.
function problemSeverityText(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  const walk = (node: any): string | null => {
    for (const er of asArray(node?.entryRelationship)) {
      const inner = er?.observation;
      if (!inner) continue;
      const tids = asArray(inner?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      if (tids.includes(SEVERITY_OBS_TEMPLATE)) {
        const v = Array.isArray(inner.value) ? inner.value[0] : inner.value;
        const name = codedDisplayName(v, narrativeIds);
        if (name) return name;
        const code = v?.["@_code"];
        if (code != null) return String(code);
      }
      const nested = walk(inner);
      if (nested) return nested;
    }
    return null;
  };
  return walk(obs);
}

// The problem's SIDE (#1403), from the observation's <targetSiteCode> — the CDA
// twin of FHIR's Condition.bodySite. Reads the qualifier code first (SNOMED
// laterality), then the display name / narrative text, then the site term itself
// ("Structure of left knee"). Nothing is inferred from the problem NAME.
function problemLateralityText(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  for (const site of asArray(obs?.targetSiteCode)) {
    for (const q of asArray(site?.qualifier)) {
      const qv = q?.value;
      const display = qv?.["@_displayName"];
      if (typeof display === "string" && display.trim()) return display.trim();
      if (qv?.["@_code"] != null) return String(qv["@_code"]);
    }
    const name = codedDisplayName(site, narrativeIds);
    if (name) return name;
  }
  return null;
}

// Map one Problem Concern Act (template 4.3) to an ImportedCondition, or null when
// it carries no productive problem (nullFlavored / "no active problems").
//
// `sectionDefaultStatus` (#265): a History of Past Illness / Resolved Problems
// section passes "resolved" — the SECTION asserts the problem is past, so the
// concern act's tracking statusCode (often still "active" while the resolved
// problem is tracked) is ignored, while an explicit clinical-status observation
// (template 4.6) on the problem stays authoritative. The Problems section passes
// nothing and keeps the existing clinical-status ?? concern-status resolution.
export function mapCondition(
  act: any,
  narrativeIds: Record<string, string>,
  sectionDefaultStatus?: ImportedCondition["status"]
): ImportedCondition | null {
  if (!act) return null;
  const concernStatus = act?.statusCode?.["@_code"] ?? null;
  // The problem observation lives under the concern act's SUBJ entryRelationship.
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(PROBLEM_OBS_TEMPLATE) || o?.value != null;
    });
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
  const name =
    codedDisplayName(value, narrativeIds) ||
    resolveNarrativeText(obs?.text, narrativeIds) ||
    codedDisplayName(obs?.code, narrativeIds);
  if (!name || isNoKnownProblemText(name)) return null;
  const { code, system } = pickCode(value);
  const clinicalStatus = clinicalStatusFromEntryRelationships(obs);
  const status =
    sectionDefaultStatus != null
      ? clinicalStatus != null
        ? toConditionStatus(clinicalStatus)
        : sectionDefaultStatus
      : toConditionStatus(clinicalStatus ?? concernStatus);
  const onset = effTime(obs.effectiveTime);
  // effectiveTime high = resolution date (only meaningful once resolved).
  const highRaw = asArray(obs.effectiveTime)
    .map((t: any) => t?.high?.["@_value"])
    .find(Boolean);
  const resolved = status === "resolved" ? hl7Date(highRaw) : null;
  // Import intelligence (#590): downgrade a birth-event or stale self-limited
  // active row to resolved. An EXPLICIT clinical-status observation (template 4.6)
  // is authoritative — flag it so the decision leaves it untouched. Onset is left
  // exactly as the document carried it (a problem-list entry never gets a fabricated
  // document-date onset — issue non-goal).
  const decided = decideImportedConditionStatus({
    name,
    code,
    status,
    onsetDate: onset,
    resolvedDate: resolved,
    explicitStatus: clinicalStatus != null,
  });
  return {
    name,
    code,
    code_system: system,
    status: decided.status,
    // Side + grade the document already carried and the importer used to drop
    // (#1403), coerced onto the CHECK sets by the shared normalizers. CCD has no
    // problem-stage element, so `stage` stays unstated on this path.
    laterality: toConditionLaterality(problemLateralityText(obs, narrativeIds)),
    severity: toConditionSeverity(problemSeverityText(obs, narrativeIds)),
    onset_date: decided.onset_date,
    resolved_date: decided.resolved_date,
    external_id: conditionExternalId({ name, code, onsetDate: onset }),
  };
}

export const problemsExtractor: SectionExtractor = {
  key: "problems",
  matches: (s) => sectionIs(s, SECTIONS.problems),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      conditions: s.entries
        .map((e) => mapCondition(e?.act, narrativeIds))
        .filter((x): x is ImportedCondition => x != null),
    };
  },
};

// History of Past Illness / "Resolved Problems" (#265): the same Problem Concern
// Act entries as the Problems section, landed in the conditions store with a
// section-level default status of `resolved` (see mapCondition).
export const pastIllnessExtractor: SectionExtractor = {
  key: "pastIllness",
  matches: (s) => sectionIs(s, SECTIONS.pastIllness),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      conditions: s.entries
        .map((e) => mapCondition(e?.act, narrativeIds, "resolved"))
        .filter((x): x is ImportedCondition => x != null),
    };
  },
};
