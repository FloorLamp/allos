// Laterality / severity / stage on a problem-list condition (issue #1403). ONE pure
// layer: the coercions every write and import boundary runs, and the ONE label
// builder every surface that names a condition renders.
//
// The identity rule (#482/#531, AGENTS.md "labels must include the attribute that
// actually distinguishes otherwise identical choices"): a sided condition is a
// distinct clinical entity, so "Osteoarthritis of knee" on the left and on the
// right must not render as two identical rows. `conditionDisplayLabel` appends the
// side — and ONLY when the name does not already say it, so an imported
// "Osteoarthritis, left knee" never becomes "Osteoarthritis, left knee (left)".
//
// PURE (no DB/network/clock): unit-tested in lib/__tests__/condition-attributes.test.ts.

import { normalizeLaterality } from "./imaging-study";
import {
  CONDITION_SEVERITIES,
  type ConditionLaterality,
  type ConditionSeverity,
} from "./types/medical";

// SNOMED CT codes FHIR's Condition.severity value set uses, and the same three the
// CCD Problem Severity observation (2.16.840.1.113883.10.20.22.4.8) carries.
const SNOMED_SEVERITY: Record<string, ConditionSeverity> = {
  "255604002": "mild",
  "6736007": "moderate",
  "24484000": "severe",
  // "Moderate to severe" / "mild to moderate" gradings some sources emit — read to
  // the HIGHER grade they assert, never invented above what the source said.
  "371924009": "severe", // moderate to severe
  "371923003": "moderate", // mild to moderate
};

// SNOMED CT body-laterality qualifier codes, as they appear on a FHIR
// Condition.bodySite coding or a CDA targetSiteCode qualifier.
const SNOMED_LATERALITY: Record<string, ConditionLaterality> = {
  "7771000": "left",
  "24028007": "right",
  "51440002": "bilateral",
};

// A word-boundary side mention inside a longer body-site phrase ("Structure of left
// kidney", "bilateral knees"). Boundaries matter: a naive substring test reads
// "cleft palate" as left-sided.
const SIDE_IN_TEXT: { re: RegExp; value: ConditionLaterality }[] = [
  { re: /\bbilateral\b|\bboth\s+sides?\b/i, value: "bilateral" },
  { re: /\bleft\b|\bl\/?t\b/i, value: "left" },
  { re: /\bright\b|\br\/?t\b/i, value: "right" },
];

// Coerce a stated side onto the condition enum. Runs the SHARED imaging normalizer
// first (one question, one computation — "Left", "lt", "bilateral", "both" already
// resolve there), dropping its 'na' member which the condition vocabulary does not
// carry, then falls back to a word-boundary scan so a body-SITE phrase resolves too.
// Anything else → null (unstated is never guessed).
export function toConditionLaterality(
  raw: unknown
): ConditionLaterality | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const shared = normalizeLaterality(s);
  if (shared === "left" || shared === "right" || shared === "bilateral")
    return shared;
  if (shared === "na") return null;
  if (SNOMED_LATERALITY[s]) return SNOMED_LATERALITY[s];
  for (const { re, value } of SIDE_IN_TEXT) if (re.test(s)) return value;
  return null;
}

// Coerce a stated grade onto the severity enum: the enum term itself, a SNOMED
// severity code, or a phrase containing one of the three grades ("Severe
// persistent asthma"). Anything else → null.
export function toConditionSeverity(raw: unknown): ConditionSeverity | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (SNOMED_SEVERITY[s]) return SNOMED_SEVERITY[s];
  const lower = s.toLowerCase();
  const exact = CONDITION_SEVERITIES.find((v) => v === lower);
  if (exact) return exact;
  // Order matters: "moderate to severe" must read as severe, not moderate.
  for (const v of ["severe", "moderate", "mild"] as const) {
    if (new RegExp(`\\b${v}\\b`, "i").test(lower)) return v;
  }
  return null;
}

// A free-text stage, trimmed to null. No vocabulary: staging systems are open-ended
// and a wrong coercion would silently rewrite an oncologist's words.
export function toConditionStage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

// The fields the label builders read — a structural subset of Condition, so a stored
// row, an import projection and a test fixture all satisfy it directly.
export interface ConditionAttributes {
  name: string;
  laterality?: ConditionLaterality | null;
  severity?: ConditionSeverity | null;
  stage?: string | null;
}

const SIDE_LABEL: Record<ConditionLaterality, string> = {
  left: "left",
  right: "right",
  bilateral: "bilateral",
};

// The display name for a condition, side included. THE identity rule (#482/#531):
// two same-named rows on different sides must never render identically. The side is
// omitted when the name already states it (an imported "Osteoarthritis, left knee"),
// so the label reads once, not twice.
export function conditionDisplayLabel(c: ConditionAttributes): string {
  const name = c.name.trim();
  if (!c.laterality) return name;
  if (toConditionLaterality(name) === c.laterality) return name;
  return `${name} (${SIDE_LABEL[c.laterality]})`;
}

// The GRADE line for a condition — severity and/or stage, in that order, or null
// when the row states neither. Separate from the label so a surface can render it as
// its own badge/sub-line rather than lengthening the name.
export function conditionGradeLabel(c: ConditionAttributes): string | null {
  const parts: string[] = [];
  if (c.severity) parts.push(c.severity[0].toUpperCase() + c.severity.slice(1));
  const stage = c.stage?.trim();
  // "Stage" is prefixed only when the stored value does not already say it anywhere
  // ("CKD stage 3b" must not become "Stage CKD stage 3b").
  if (stage) parts.push(/\bstage\b/i.test(stage) ? stage : `Stage ${stage}`);
  return parts.length ? parts.join(" · ") : null;
}
