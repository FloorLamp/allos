// Risk-stratified retest & screening priority (issue #517). ONE pure layer that
// takes already-gathered profile inputs — family history, active conditions,
// smoking, life stage (#494), and the occupational/immune-status profile
// attributes — and answers two questions the flat per-analyte cadence could not:
//
//   1. CADENCE MODULATION — an analyte's/screening's base interval scaled by the
//      matched risk rules (family cardiac history → lipids retested sooner;
//      immunocompromised / dialysis / healthcare worker → hepatitis-A immunity
//      checked sooner).
//   2. PRIORITY RANKING — retest/screening items gain a clinical-importance weight
//      so a high-risk-driven lipid retest outranks a routine one (the Upcoming
//      within-band tiebreak), and the item can explain WHY in a calm line.
//   3. ANCHORED ONE-SHOTS — a birth-anchored newborn analyte (bilirubin, metabolic
//      screen) drawn in infancy is a life-stage milestone, NOT a recurring retest,
//      so it never nags on a yearly clock.
//
// DETERMINISTIC and CONSERVATIVE, mirroring the preventive concept-map and
// immunization catalogs: only curated, specific rules apply, each carries an
// informational source, and the framing stays "simplified, not clinical advice".
// This module is PURE (no DB/network) — the profile-scoped gather lives in the
// query layer (lib/queries/upcoming) and hands it plain inputs, so the thresholds
// are unit-tested in isolation (lib/__tests__/risk-stratification.test.ts).

import type { LifeStage } from "./life-stage";

// The curated risk factors the layer recognizes. A stable, closed set — a new
// factor is added here with its rule(s) below and its derivation in
// deriveRiskFactors, never invented at a call site.
export type RiskFactor =
  | "family-cardiovascular"
  | "family-cancer"
  | "family-diabetes"
  | "diabetes"
  | "hypertension"
  | "chronic-kidney-disease"
  | "healthcare-worker"
  | "immunocompromised"
  | "dialysis"
  | "pregnant";

// The occupational / immune-status attributes stored per profile (profile_settings,
// no schema change). Distinct from the clinical conditions/family-history the app
// already stores — these are self-declared context the risk rules need.
export interface RiskAttributes {
  healthcareWorker: boolean;
  immunocompromised: boolean;
  dialysis: boolean;
  pregnant: boolean;
}

export const EMPTY_RISK_ATTRIBUTES: RiskAttributes = {
  healthcareWorker: false,
  immunocompromised: false,
  dialysis: false,
  pregnant: false,
};

// The already-gathered inputs the classifier reads. The query layer fills these
// from profile-scoped reads; this module never touches the DB.
export interface RiskInputs {
  // Raw family_history.condition strings (any relation).
  familyConditions: string[];
  // Names of the profile's ACTIVE conditions.
  activeConditions: string[];
  attributes: RiskAttributes;
}

// Normalize a free-text clinical label for keyword matching: lowercased, trimmed,
// non-alphanumerics collapsed to single spaces (so "Type 2 Diabetes" and
// "type-2 diabetes" match the same keywords).
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Keyword sets for deriving a factor from a free-text condition label. Substring
// (not whole-word) is intentional here — clinical labels are verbose ("coronary
// artery disease", "chronic kidney disease stage 3") and these stems are specific
// enough not to false-match.
const FAMILY_KEYWORDS: { factor: RiskFactor; stems: string[] }[] = [
  {
    factor: "family-cardiovascular",
    stems: [
      "heart disease",
      "heart attack",
      "coronary",
      "cardiac",
      "myocardial",
      "cardiovascular",
      "stroke",
    ],
  },
  {
    factor: "family-cancer",
    stems: ["cancer", "carcinoma", "melanoma", "lymphoma", "leukemia"],
  },
  { factor: "family-diabetes", stems: ["diabetes", "diabetic"] },
];

const CONDITION_KEYWORDS: { factor: RiskFactor; stems: string[] }[] = [
  { factor: "diabetes", stems: ["diabetes", "diabetic"] },
  { factor: "hypertension", stems: ["hypertension", "high blood pressure"] },
  {
    factor: "chronic-kidney-disease",
    stems: [
      "chronic kidney",
      "renal failure",
      "ckd",
      "esrd",
      "dialysis",
      "nephropathy",
    ],
  },
];

// Derive the active risk factors from the gathered inputs. Pure and total — an
// empty input yields an empty set. Family and personal conditions are keyword-
// matched; the occupational/immune attributes map straight through.
export function deriveRiskFactors(inputs: RiskInputs): Set<RiskFactor> {
  const factors = new Set<RiskFactor>();

  for (const raw of inputs.familyConditions) {
    const n = norm(raw);
    for (const { factor, stems } of FAMILY_KEYWORDS) {
      if (stems.some((s) => n.includes(s))) factors.add(factor);
    }
  }
  for (const raw of inputs.activeConditions) {
    const n = norm(raw);
    for (const { factor, stems } of CONDITION_KEYWORDS) {
      if (stems.some((s) => n.includes(s))) factors.add(factor);
    }
  }

  if (inputs.attributes.healthcareWorker) factors.add("healthcare-worker");
  if (inputs.attributes.immunocompromised) factors.add("immunocompromised");
  if (inputs.attributes.dialysis) {
    factors.add("dialysis");
    // Dialysis implies advanced kidney disease — the retest rules keyed on CKD
    // apply too, without requiring a separately-coded condition row.
    factors.add("chronic-kidney-disease");
  }
  if (inputs.attributes.pregnant) factors.add("pregnant");

  return factors;
}

// A curated risk rule: a factor that modulates the cadence and/or ranks up a set
// of analytes and/or screening rules. `names` matches an analyte's canonical name
// exactly (lowercased); `nameContains` matches a substring (for uncurated analytes
// like a hepatitis-A titer with no canonical entry). `cadenceMultiplier` < 1
// tightens the retest interval; `priority` is the ranking weight; `reason` is the
// calm human line; `source` the informational citation.
export interface RiskRule {
  factor: RiskFactor;
  names?: string[];
  nameContains?: string[];
  screeningRules?: string[];
  cadenceMultiplier: number;
  priority: number;
  reason: string;
  source: string;
}

const LIPID_ANALYTES = [
  "total cholesterol",
  "ldl cholesterol",
  "hdl cholesterol",
  "non-hdl cholesterol",
  "triglycerides",
];

export const RISK_RULES: RiskRule[] = [
  // Family history of cardiovascular disease → the lipid panel is retested sooner
  // and ranks above a routine lab, and the lipid SCREENING is prioritized.
  {
    factor: "family-cardiovascular",
    names: LIPID_ANALYTES,
    screeningRules: ["lipid_screening"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Family history of heart disease",
    source: "ACC/AHA (informational)",
  },
  // Managing diabetes → HbA1c on a tighter (≈ quarterly-of-its-base) clock and
  // ranked up. (An in-range A1c still curates to ~90d; this keeps a flagged/at-risk
  // one from drifting to the flat annual fallback when uncurated.)
  {
    factor: "diabetes",
    names: ["hemoglobin a1c"],
    screeningRules: ["diabetes_screening"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Managing diabetes",
    source: "ADA (informational)",
  },
  // Chronic kidney disease (or dialysis, which implies it) → kidney-function
  // analytes retested sooner and ranked up.
  {
    factor: "chronic-kidney-disease",
    names: ["egfr", "creatinine"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Chronic kidney disease",
    source: "KDIGO (informational)",
  },
  // Immune-status / occupational exposure → hepatitis-A immunity checked more
  // often (revaccination when immunity wanes). Matched by substring so an
  // uncurated "Hepatitis A IgG / Antibody" reading is recognized.
  {
    factor: "immunocompromised",
    nameContains: ["hepatitis a"],
    cadenceMultiplier: 0.5,
    priority: 1,
    reason: "Immunocompromised",
    source: "ACIP (informational)",
  },
  {
    factor: "dialysis",
    nameContains: ["hepatitis a"],
    cadenceMultiplier: 0.5,
    priority: 1,
    reason: "On dialysis",
    source: "ACIP (informational)",
  },
  {
    factor: "healthcare-worker",
    nameContains: ["hepatitis a"],
    cadenceMultiplier: 0.5,
    priority: 1,
    reason: "Healthcare worker",
    source: "ACIP (informational)",
  },
];

// Whether a rule targets the given analyte (by exact canonical name or substring).
function ruleMatchesAnalyte(rule: RiskRule, canonicalName: string): boolean {
  const n = canonicalName.trim().toLowerCase();
  if (rule.names?.includes(n)) return true;
  if (rule.nameContains?.some((s) => n.includes(s))) return true;
  return false;
}

// The combined modulation applied to a retest item. `multiplier` is the TIGHTEST
// matched multiplier (min — the most cautious cadence wins); `priority` is the
// highest matched weight (0 when nothing matched); `reasons` are the unique calm
// lines, ordered by descending priority then insertion.
export interface RetestModulation {
  multiplier: number;
  priority: number;
  reasons: string[];
}

export const NO_MODULATION: RetestModulation = {
  multiplier: 1,
  priority: 0,
  reasons: [],
};

export function retestModulationFor(
  canonicalName: string,
  factors: ReadonlySet<RiskFactor>
): RetestModulation {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && ruleMatchesAnalyte(r, canonicalName)
  );
  if (matched.length === 0) return NO_MODULATION;
  const multiplier = Math.min(...matched.map((r) => r.cadenceMultiplier));
  const priority = Math.max(...matched.map((r) => r.priority));
  const reasons = uniqueReasons(matched);
  return { multiplier, priority, reasons };
}

// The priority + reasons a screening rule earns from the active factors (no
// cadence side — the screening catalog interval is unchanged; this only ranks and
// explains). priority 0 with no reasons when nothing matched.
export function screeningPriorityFor(
  ruleKey: string,
  factors: ReadonlySet<RiskFactor>
): { priority: number; reasons: string[] } {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && r.screeningRules?.includes(ruleKey)
  );
  if (matched.length === 0) return { priority: 0, reasons: [] };
  return {
    priority: Math.max(...matched.map((r) => r.priority)),
    reasons: uniqueReasons(matched),
  };
}

function uniqueReasons(rules: RiskRule[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (!seen.has(r.reason)) {
      seen.add(r.reason);
      out.push(r.reason);
    }
  }
  return out;
}

// ---- Anchored one-shots (issue #517 item 4) --------------------------------
// A birth-anchored newborn analyte drawn in infancy is a life-stage milestone,
// not a recurring retest — a newborn bilirubin / metabolic screen is done once
// and must not reappear on a yearly retest clock. Distinguished by the AGE AT THE
// READING (an adult bilirubin is a normal recurring LFT), so the same analyte
// name recurs for adults and one-shots for newborns.
const NEWBORN_ONESHOT_CONTAINS = [
  "bilirubin",
  "newborn screen",
  "newborn metabolic",
  "metabolic screen",
];

// The life stage a reading was drawn in — the caller resolves the age on the
// reading DATE (not today) and classifies it. Only "infant" gates the one-shot.
export function isAnchoredOneShotReading(
  canonicalName: string,
  lifeStageAtReading: LifeStage | null
): boolean {
  if (lifeStageAtReading !== "infant") return false;
  const n = canonicalName.trim().toLowerCase();
  return NEWBORN_ONESHOT_CONTAINS.some((s) => n.includes(s));
}
