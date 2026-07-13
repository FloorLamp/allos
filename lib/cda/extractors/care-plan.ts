// CDA section extractors — care plan and goals. The care-plan-item and care-goal
// mappers and the care-plan + goals section extractors.
import { careGoalExternalId, carePlanExternalId } from "../../clinical-parse";
import type {
  ImportedCareGoal,
  ImportedCarePlanItem,
} from "../../health-import";
import { CARE_PLAN_ELEMENTS, SECTIONS } from "../constants";
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

// Map one Plan-of-Treatment / Care-Plan section entry to an ImportedCarePlanItem,
// or null when it carries no usable description. Description prefers the coded
// displayName / narrative; planned date is the effectiveTime (period low else a
// point); status is the statusCode; the performer is the ordering clinician;
// category comes from the planned element type.
function mapCarePlanItem(
  entry: any,
  ids: Record<string, string>
): ImportedCarePlanItem | null {
  if (!entry) return null;
  const picked = CARE_PLAN_ELEMENTS.map((e) => ({
    node: entry[e.key],
    category: e.category,
  })).find((e) => e.node != null);
  if (!picked) return null;
  const node = picked.node;
  if (truthyNegation(node["@_negationInd"])) return null;
  const description =
    codedDisplayName(node?.code, ids) || resolveNarrativeText(node?.text, ids);
  if (!description) return null;
  const { code, system } = pickCode(node?.code);
  const { start } = hl7Period(node?.effectiveTime);
  const plannedDate = start ?? effTime(node?.effectiveTime);
  const status =
    typeof node?.statusCode?.["@_code"] === "string"
      ? String(node.statusCode["@_code"])
      : null;
  const provider = providerFromPerformer(node, "individual");
  return {
    description,
    code,
    code_system: system,
    category: picked.category,
    planned_date: plannedDate,
    status,
    provider,
    external_id: carePlanExternalId({ description, code, plannedDate }),
  };
}

// ---- goals ----

// Map one Goals-section entry (a Goal Observation, template 4.121) to an
// ImportedCareGoal, or null when it carries no usable description. Description
// prefers the coded <value> displayName, else the narrative, else the <code>
// displayName; target date is the effectiveTime; status is the statusCode.
function mapCareGoal(
  obs: any,
  ids: Record<string, string>
): ImportedCareGoal | null {
  if (!obs || truthyNegation(obs["@_negationInd"])) return null;
  const value = Array.isArray(obs.value) ? obs.value[0] : obs.value;
  const description =
    codedDisplayName(value, ids) ||
    resolveNarrativeText(obs?.text, ids) ||
    codedDisplayName(obs?.code, ids) ||
    (typeof value?.["#text"] === "string" ? value["#text"].trim() : null);
  if (!description) return null;
  // Prefer the value's coding (the measured target), else the observation code.
  const { code, system } =
    value != null && value["@_code"] != null
      ? pickCode(value)
      : pickCode(obs?.code);
  const { start } = hl7Period(obs?.effectiveTime);
  const targetDate = start ?? effTime(obs?.effectiveTime);
  const status =
    typeof obs?.statusCode?.["@_code"] === "string"
      ? String(obs.statusCode["@_code"])
      : null;
  return {
    description,
    code,
    code_system: system,
    target_date: targetDate,
    status,
    external_id: careGoalExternalId({ description, code, targetDate }),
  };
}

// ---- social history ----

export const carePlanExtractor: SectionExtractor = {
  key: "carePlan",
  matches: (s) => sectionIs(s, SECTIONS.carePlan),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      carePlanItems: s.entries
        .map((e) => mapCarePlanItem(e, narrativeIds))
        .filter((x): x is ImportedCarePlanItem => x != null),
    };
  },
};

export const goalsExtractor: SectionExtractor = {
  key: "goals",
  matches: (s) => sectionIs(s, SECTIONS.goals),
  extract: (s) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      careGoals: s.entries
        .map((e) => mapCareGoal(e?.observation, narrativeIds))
        .filter((x): x is ImportedCareGoal => x != null),
    };
  },
};
