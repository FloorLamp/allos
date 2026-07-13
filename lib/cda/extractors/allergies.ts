// CDA section extractors — allergies. The allergy mapper (with its reaction /
// severity helpers) and the allergies section extractor.
import {
  allergyExternalId,
  isNoKnownAllergy,
  toAllergyStatus,
} from "../../clinical-parse";
import type { ImportedAllergy } from "../../health-import";
import {
  ALLERGY_OBS_TEMPLATE,
  SECTIONS,
  SEVERITY_OBS_TEMPLATE,
} from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  clinicalStatusFromEntryRelationships,
  codedDisplayName,
  collectText,
  effTime,
  pickCode,
  sectionIs,
  textOf,
  truthyNegation,
} from "../normalize";

// The reaction/manifestation text off an allergy observation's MFST/reaction
// entryRelationship (Reaction Observation): its value displayName or narrative.
function allergyReaction(
  obs: any,
  narrativeIds: Record<string, string>
): string | null {
  for (const er of asArray(obs?.entryRelationship)) {
    const inner = er?.observation;
    if (!inner) continue;
    const tids = asArray(inner?.templateId)
      .map((t: any) => t?.["@_root"])
      .filter(Boolean);
    // A reaction observation is template 4.9; but Epic also nests manifestations
    // with a MFST typeCode. Take a coded value that isn't the severity/criticality.
    if (tids.includes(SEVERITY_OBS_TEMPLATE)) continue;
    const codeVal = inner?.code?.["@_code"];
    if (codeVal === "82606-5") continue; // criticality, not a reaction
    const name = codedDisplayName(
      Array.isArray(inner.value) ? inner.value[0] : inner.value,
      narrativeIds
    );
    if (name) return name;
  }
  return null;
}

// The severity word off an allergy observation's Severity Observation (4.8).
function allergySeverity(
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
      }
      const nested = walk(inner);
      if (nested) return nested;
    }
    return null;
  };
  return walk(obs);
}

// Map one Allergy Concern Act (template 4.30) to an ImportedAllergy, or null for a
// "No known allergies" statement (negated assertion / narrative) — no junk row.
export function mapAllergy(
  act: any,
  narrativeIds: Record<string, string>,
  sectionNarrative: string | null
): ImportedAllergy | null {
  if (!act) return null;
  const concernStatus = act?.statusCode?.["@_code"] ?? null;
  const obs = asArray(act?.entryRelationship)
    .map((er: any) => er?.observation)
    .find((o: any) => {
      const tids = asArray(o?.templateId)
        .map((t: any) => t?.["@_root"])
        .filter(Boolean);
      return tids.includes(ALLERGY_OBS_TEMPLATE) || o?.participant != null;
    });
  if (!obs) return null;
  // Substance: participant[CSM]/participantRole/playingEntity/code.
  const playing = asArray(obs?.participant)
    .map((p: any) => p?.participantRole?.playingEntity)
    .find(Boolean);
  const substanceCodeNode = playing?.code;
  const substance =
    codedDisplayName(substanceCodeNode, narrativeIds) ||
    textOf(playing?.name)?.trim() ||
    null;
  const negated = truthyNegation(obs["@_negationInd"]);
  if (
    isNoKnownAllergy({
      negated,
      substanceName: substance,
      narrative: sectionNarrative,
    })
  ) {
    return null;
  }
  if (!substance) return null;
  const { code, system } = pickCode(substanceCodeNode);
  const status = toAllergyStatus(
    clinicalStatusFromEntryRelationships(obs) ?? concernStatus
  );
  const onset = effTime(obs.effectiveTime);
  return {
    substance,
    substance_code: code,
    substance_code_system: system,
    reaction: allergyReaction(obs, narrativeIds),
    severity: allergySeverity(obs, narrativeIds),
    status,
    onset_date: onset,
    external_id: allergyExternalId({
      substance,
      substanceCode: code,
      onsetDate: onset,
    }),
  };
}

// ---- encounters / visits ----

export const allergiesExtractor: SectionExtractor = {
  key: "allergies",
  matches: (s) => sectionIs(s, SECTIONS.allergies),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    const sectionNarrative = collectText(s.raw?.text)
      .replace(/\s+/g, " ")
      .trim();
    return {
      allergies: s.entries
        .map((e) => mapAllergy(e?.act, narrativeIds, sectionNarrative))
        .filter((x): x is ImportedAllergy => x != null),
    };
  },
};
