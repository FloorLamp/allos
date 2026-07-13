// CDA section extractors — family history. The family-history organizer mapper
// (with its relation / onset-age / deceased helpers) and the section extractor.
import {
  familyHistoryExternalId,
  isNoKnownProblemText,
} from "../../clinical-parse";
import type { ImportedFamilyHistory } from "../../health-import";
import {
  AGE_OBS_TEMPLATE,
  FAMILY_OBS_TEMPLATE,
  FAMILY_RELATION_LABELS,
  SECTIONS,
} from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  codedDisplayName,
  pickCode,
  resolveNarrativeText,
  sectionIs,
  truthyNegation,
} from "../normalize";

// The affected relative for a Family History Organizer: prefer the relatedSubject
// <code>'s displayName, else map its code, else the raw code. Null when absent.
function familyRelation(org: any): string | null {
  const code = org?.subject?.relatedSubject?.code;
  const display = code?.["@_displayName"];
  if (typeof display === "string" && display.trim()) return display.trim();
  const raw = code?.["@_code"];
  if (raw != null) {
    const key = String(raw).trim().toUpperCase();
    return FAMILY_RELATION_LABELS[key] ?? String(raw).trim();
  }
  return null;
}

// The relative's age (whole years) at the condition's onset, from a nested Age
// Observation (template 4.31) whose <value> is a PQ in years. Null when absent or
// not year-valued.
function familyOnsetAge(obs: any): number | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    const tids = asArray(inner?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    if (!tids.includes(AGE_OBS_TEMPLATE)) continue;
    const v = Array.isArray(inner?.value) ? inner.value[0] : inner?.value;
    const unit = v?.["@_unit"];
    const num = Number(v?.["@_value"]);
    // Accept year units ('a' / 'yr' / 'year(s)') or an absent unit.
    if (
      Number.isFinite(num) &&
      (unit == null || /^a$|yr|year/i.test(String(unit)))
    )
      return Math.round(num);
  }
  return null;
}

// Whether the relative is recorded as deceased: a nested Death Observation whose
// value codes SNOMED "Dead" (419099009), found anywhere under the organizer (a
// sibling component observation or nested under a condition's entryRelationship).
// Returns 1 when found, else null (unknown — we don't assert "alive").
function familyDeceased(org: any): number | null {
  const walk = (node: any): boolean => {
    if (node == null || typeof node !== "object") return false;
    const v = Array.isArray(node?.value) ? node.value[0] : node?.value;
    if (v?.["@_code"] === "419099009") return true;
    for (const child of [
      ...asArray(node?.component),
      ...asArray(node?.entryRelationship),
      ...asArray(node?.observation),
    ]) {
      if (walk(child?.observation ?? child)) return true;
    }
    return false;
  };
  return walk(org) ? 1 : null;
}

// Map one Family History Organizer (one relative) to zero or more
// ImportedFamilyHistory rows — one per Family History Observation (4.46) it carries
// that names a condition. Relation + deceased are read once off the organizer.
function familyHistoryFromOrganizer(
  org: any,
  ids: Record<string, string>
): ImportedFamilyHistory[] {
  if (!org) return [];
  const relation = familyRelation(org);
  const out: ImportedFamilyHistory[] = [];
  for (const comp of asArray(org?.component)) {
    const obs = comp?.observation;
    if (!obs || truthyNegation(obs["@_negationInd"])) continue;
    const tids = asArray(obs?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    // A Family History Observation is 4.46; also accept a bare valued observation
    // so a slightly-off template still imports its condition.
    if (!tids.includes(FAMILY_OBS_TEMPLATE) && obs?.value == null) continue;
    const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
    const condition =
      codedDisplayName(value, ids) ||
      resolveNarrativeText(obs?.text, ids) ||
      codedDisplayName(obs?.code, ids);
    if (!condition || isNoKnownProblemText(condition)) continue;
    const { code, system } = pickCode(value);
    out.push({
      relation,
      condition,
      code,
      code_system: system,
      onset_age: familyOnsetAge(obs),
      deceased: familyDeceased(org),
      external_id: familyHistoryExternalId({ relation, condition, code }),
    });
  }
  return out;
}

// ---- care plan / plan of treatment ----

export const familyHistoryExtractor: SectionExtractor = {
  key: "familyHistory",
  matches: (s) => sectionIs(s, SECTIONS.familyHistory),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      familyHistory: s.entries.flatMap((e) =>
        familyHistoryFromOrganizer(e?.organizer, narrativeIds)
      ),
    };
  },
};
