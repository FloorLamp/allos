// CDA section extractors — procedures. The procedure mapper and the procedures
// section extractor.
import { procedureExternalId } from "../../clinical-parse";
import type { ImportedProcedure } from "../../health-import";
import { SECTIONS } from "../constants";
import type { SectionExtractor } from "../constants";
import {
  buildNarrativeIdMap,
  codedDisplayName,
  effTime,
  hl7Period,
  pickCode,
  providerFromPerformer,
  resolveNarrativeText,
  sectionIs,
  truthyNegation,
} from "../normalize";

// Map one Procedures-section entry (a Procedure Activity — procedure / act /
// observation flavor) to an ImportedProcedure, or null when it carries no usable
// name. Name prefers the coded displayName / narrative originalText; date is the
// effectiveTime (period low, else a point); the performer is the operating
// clinician. code/code_system are the CPT/SNOMED identity.
function mapProcedure(
  node: any,
  ids: Record<string, string>
): ImportedProcedure | null {
  if (!node || truthyNegation(node["@_negationInd"])) return null;
  const name =
    codedDisplayName(node?.code, ids) || resolveNarrativeText(node?.text, ids);
  if (!name) return null;
  const { code, system } = pickCode(node?.code);
  const { start } = hl7Period(node?.effectiveTime);
  const date = start ?? effTime(node?.effectiveTime);
  const provider = providerFromPerformer(node, "individual");
  return {
    name,
    code,
    code_system: system,
    date,
    provider,
    external_id: procedureExternalId({ name, code, date }),
  };
}

// ---- family history ----

export const proceduresExtractor: SectionExtractor = {
  key: "procedures",
  matches: (s) => sectionIs(s, SECTIONS.procedures),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      procedures: s.entries
        // A Procedure Activity entry carries the act under procedure / act /
        // observation depending on the flavor; take whichever is present.
        .map((e) =>
          mapProcedure(e?.procedure ?? e?.act ?? e?.observation, narrativeIds)
        )
        .filter((x): x is ImportedProcedure => x != null),
    };
  },
};
