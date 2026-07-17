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
import type { SmokingStatusValue } from "./smoking";
import type { GenomicResultType, GenomicSignificance } from "./types/medical";

// The curated risk factors the layer recognizes. A stable, closed set — a new
// factor is added here with its rule(s) below and its derivation in
// deriveRiskFactors, never invented at a call site.
export type RiskFactor =
  | "family-cardiovascular"
  | "family-cancer"
  | "family-diabetes"
  | "family-glaucoma"
  // Hereditary-risk genomic factors (#711 / #707 Phase 2). Each is activated ONLY
  // by a stored PATHOGENIC / likely-pathogenic `hereditary-risk` variant in a gene
  // that carries an ESTABLISHED screening guideline (the exclusion discipline that
  // keeps predictive-only variants — APOE ε4, Huntington — out of the cadence path).
  | "hereditary-breast-cancer" // BRCA1/BRCA2 → mammography (+ breast MRI in the reason)
  | "hereditary-colorectal-cancer" // Lynch (MLH1/MSH2/MSH6/PMS2/EPCAM) → colonoscopy
  | "familial-hypercholesterolemia" // LDLR/APOB/PCSK9 → lipid screening
  | "diabetes"
  | "hypertension"
  | "chronic-kidney-disease"
  | "current-smoking"
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
  // The profile's resolved smoking status (lib/smoking) — `current` activates the
  // current-smoking factor (a periodontal-risk input for the dental visit cadence,
  // #706). Optional so existing callers/tests that predate the smoking input keep
  // working (absence/null → no smoking factor), mirroring the smoking-history
  // resolver's "null is data, not a guess" tri-state.
  smokingStatus?: SmokingStatusValue | null;
  // Stored genomic variants (#709) — the hereditary-risk input class (#711). A
  // structural subset of GenomicVariant so getGenomicVariants rows satisfy it
  // directly. Optional so callers/tests predating the genomic input keep working
  // (absence → no genomic factor). Only PATHOGENIC/likely-pathogenic
  // `hereditary-risk` variants in a curated gene drive cadence — the significance +
  // result_type gates live in deriveRiskFactors, NOT here (a raw stored variant is
  // handed through unfiltered, mirroring how the raw condition/family strings are).
  genomicVariants?: GenomicRiskInput[];
}

// The variant fields the hereditary-risk classifier reads — a structural subset of
// GenomicVariant (gene + the two ROUTING discriminators). Keyed on the GENE (the
// #482 identity anchor), matching how the PGx cross-check (#710) keys on gene.
export interface GenomicRiskInput {
  gene: string;
  significance: GenomicSignificance | null;
  result_type: GenomicResultType;
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
  // Family history of glaucoma → earlier / more frequent comprehensive eye exams
  // (AAO). Drives the vision_exam visit cadence (#699). "glaucoma" is specific
  // enough to substring-match without false positives.
  { factor: "family-glaucoma", stems: ["glaucoma"] },
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

// The curated GENE → hereditary-risk factor table (#711). EXCLUSION-DISCIPLINED:
// only genes with an ESTABLISHED screening guideline get an entry, so a variant in a
// gene NOT listed here (APOE ε4, HTT/Huntington, and every other predictive-only
// result) produces ZERO factors — no cadence change, no risk text. This table IS the
// product constraint "store + cadence only, no risk editorializing for predictive-
// only variants": adding a gene here is a deliberate assertion that a screening
// guideline exists for it. Genes are HGNC symbols, matched case-insensitively.
const HEREDITARY_GENE_FACTORS: { factor: RiskFactor; genes: string[] }[] = [
  // Hereditary breast/ovarian cancer → earlier, more frequent breast screening
  // (NCCN: mammography + breast MRI). BRCA1/BRCA2 are the canonical high-penetrance
  // genes; kept deliberately tight (a broader panel gene like PALB2/CHEK2 is a
  // separate, lower-penetrance decision — omitted under the conservative discipline).
  { factor: "hereditary-breast-cancer", genes: ["brca1", "brca2"] },
  // Lynch syndrome (hereditary nonpolyposis colorectal cancer) → earlier, more
  // frequent colonoscopy (NCCN). The five established Lynch genes.
  {
    factor: "hereditary-colorectal-cancer",
    genes: ["mlh1", "msh2", "msh6", "pms2", "epcam"],
  },
  // Familial hypercholesterolemia → earlier, tighter lipid attention (AHA/NLA). The
  // three FH genes.
  { factor: "familial-hypercholesterolemia", genes: ["ldlr", "apob", "pcsk9"] },
];

// The HGNC gene symbol from a stored `gene` value — lowercased first whitespace-
// delimited token, so a value that carries a trailing variant form ("BRCA1
// c.68_69del") still collapses to its gene identity ("brca1"), the #482 identity
// discipline applied to the gene column.
function geneSymbol(raw: string): string {
  return raw.toLowerCase().trim().split(/\s+/)[0] ?? "";
}

// Whether a stored variant DRIVES cadence: a `hereditary-risk` result that the
// report classified PATHOGENIC or likely-pathogenic. A VUS / benign / null-
// significance call, or a variant routed to another consumer (pharmacogenomic /
// carrier / diagnostic / other), never modulates screening — only an actionable
// hereditary-risk finding does.
function drivesHereditaryCadence(v: GenomicRiskInput): boolean {
  return (
    v.result_type === "hereditary-risk" &&
    (v.significance === "pathogenic" || v.significance === "likely-pathogenic")
  );
}

// Derive the active risk factors from the gathered inputs. Pure and total — an
// empty input yields an empty set. Family and personal conditions are keyword-
// matched; the occupational/immune attributes map straight through.
// The risk factors a set of ACTIVE CONDITION labels imply (via the CONDITION_KEYWORDS
// stem table). Factored out of deriveRiskFactors so a caller with only condition names
// in hand — the contrast-safety cross-check's CKD gate (#701) — reuses the SAME
// recognizer rather than a bespoke parse (AGENTS.md), and the two can't drift.
export function conditionsToRiskFactors(
  activeConditions: string[]
): Set<RiskFactor> {
  const factors = new Set<RiskFactor>();
  for (const raw of activeConditions) {
    const n = norm(raw);
    for (const { factor, stems } of CONDITION_KEYWORDS) {
      if (stems.some((s) => n.includes(s))) factors.add(factor);
    }
  }
  return factors;
}

export function deriveRiskFactors(inputs: RiskInputs): Set<RiskFactor> {
  const factors = new Set<RiskFactor>();

  for (const raw of inputs.familyConditions) {
    const n = norm(raw);
    for (const { factor, stems } of FAMILY_KEYWORDS) {
      if (stems.some((s) => n.includes(s))) factors.add(factor);
    }
  }
  for (const f of conditionsToRiskFactors(inputs.activeConditions)) {
    factors.add(f);
  }

  // Current smoking is a major periodontal-risk factor (#706). Only a CONFIRMED
  // `current` status activates it — an unknown/imported-only ever-smoker (status
  // null) does not, matching the smoking resolver's conservative tri-state (absence
  // is data, not a guess); `never`/`former` never tighten the dental cadence.
  if (inputs.smokingStatus === "current") factors.add("current-smoking");

  // Hereditary-risk genomic factors (#711). Only a PATHOGENIC / likely-pathogenic
  // `hereditary-risk` variant in a CURATED gene activates a factor — the significance
  // + result_type gates (drivesHereditaryCadence) plus the exclusion-disciplined gene
  // table (HEREDITARY_GENE_FACTORS) together keep predictive-only variants (APOE ε4,
  // Huntington) and non-actionable calls (VUS/benign) entirely out of the cadence
  // path. Multiple variants collapse onto the gene identity (a BRCA1 c.68del and a
  // bare BRCA1 both add the one breast-cancer factor).
  for (const v of inputs.genomicVariants ?? []) {
    if (!drivesHereditaryCadence(v)) continue;
    const g = geneSymbol(v.gene);
    for (const { factor, genes } of HEREDITARY_GENE_FACTORS) {
      if (genes.includes(g)) factors.add(factor);
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
  // Screening rule keys whose CADENCE this rule tightens (#711 hereditary-risk).
  // Distinct from `screeningRules` (which is priority-only — the screening catalog
  // interval is intentionally unchanged there): a hereditary-cancer / FH variant is
  // a genuine guideline reason to screen EARLIER and MORE OFTEN, so these keys feed
  // screeningModulationFor (the tightest multiplier wins, applied to the screening's
  // from-last interval) exactly like `visitRules` feeds visitModulationFor. Kept a
  // separate dimension so a factor can rank a screening WITHOUT shortening its
  // interval (the existing family-history → lipid behavior) or do both.
  screeningCadenceRules?: string[];
  // Preventive VISIT rule keys whose cadence this rule modulates (Substrate 3 of
  // the #707 roadmap; consumers #699 vision / #706 dental / future #717 hearing).
  // A recurring `kind: "visit"` catalog rule (vision_exam, dental_cleaning, …) has
  // no analyte/screening key, so it needs its own target dimension — the same
  // pattern as `names`/`screeningRules`/`immunizationCodes`, just for visit cadence.
  // A matching rule tightens the visit interval by `cadenceMultiplier` and ranks +
  // explains it via `priority`/`reason` (fed by visitModulationFor). Curated rows
  // are all a future visit-cadence domain needs — no per-domain fork.
  visitRules?: string[];
  // Vaccine catalog codes this rule ranks up (issue #553) — the immunization arm
  // of #517. A rule targeting `immunizationCodes` carries no cadence/analyte side
  // (cadenceMultiplier 1, no `names`/`screeningRules`), so it feeds ONLY
  // immunizationPriorityFor and never touches the retest or screening dimensions.
  immunizationCodes?: string[];
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
  // ---- Pregnancy (issue #521) --------------------------------------------------
  // A small, ACOG/USPSTF-defensible set keyed on the `pregnant` factor. Pregnancy
  // brings a few routine labs due sooner and ranks them up with a calm reason; the
  // set is deliberately conservative (only rules with a clear informational
  // citation). Gestational-diabetes screening — glucose is drawn/repeated in
  // pregnancy (ACOG: routine GDM screening at 24–28 weeks, earlier when higher
  // risk), so its retest tightens and the diabetes screening ranks up.
  {
    factor: "pregnant",
    names: ["glucose"],
    screeningRules: ["diabetes_screening"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Pregnancy — gestational diabetes screening",
    source: "ACOG (informational)",
  },
  // Anemia in pregnancy — ACOG recommends screening with a CBC (hemoglobin /
  // hematocrit) at the first visit and again at 24–28 weeks; ferritin gauges iron
  // stores. Retested sooner and ranked up.
  {
    factor: "pregnant",
    names: ["hemoglobin", "hematocrit", "ferritin"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Pregnancy — anemia screening",
    source: "ACOG (informational)",
  },
  // Deliberately NOT modeled: universal thyroid (TSH) screening in pregnancy.
  // ACOG/USPSTF do not recommend UNIVERSAL thyroid screening in pregnancy (it is
  // targeted to symptoms/risk), so a blanket `pregnant` → TSH rule would over-
  // remind. Omitted under the conservative-curation caveat until a defensible,
  // targeted input exists — the same "documented out-of-scope" discipline the
  // screening catalog uses for risk-defined recommendations.

  // ---- Visit-kind cadence modulation (Substrate 3, #707) -----------------------
  // The visit arm of the risk layer: the same curated-factor pattern that tightens a
  // retest / ranks a screening now modulates a recurring `kind: "visit"` preventive
  // rule's cadence, so a condition/behavior/family-history factor brings a routine
  // eye or dental visit due SOONER and explains WHY in a calm, cited line (fed by
  // visitModulationFor → the pure preventive assessor scales the interval; the reason
  // rides the Upcoming/hero item exactly like the retest reasons). Deliberately
  // conservative + informational, mirroring the retest/screening rules' discipline.
  //
  // ROOM FOR OWN-RECORD INPUTS (#699 point 6): a recorded elevated IOP or a
  // glaucoma-suspect / ocular-hypertension condition is the SAME kind of risk
  // evidence and belongs on this table as its own factor targeting vision_exam once
  // the IOP analyte lands (#698) — a flagged finding should not only trend, it should
  // pull the next exam sooner. The factor set + RiskInputs are shaped to accept that
  // additional input without a mechanism change (a new factor + row, nothing more).

  // Diabetes → annual dilated eye exam (ADA standard of care; diabetic retinopathy is
  // the leading cause of working-age blindness and is asymptomatic until late).
  // vision_exam base cadence 24mo → ~12mo.
  {
    factor: "diabetes",
    visitRules: ["vision_exam"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Diabetes on file — annual dilated eye exam recommended (ADA)",
    source: "ADA (informational)",
  },
  // Family history of glaucoma → earlier, more frequent comprehensive eye exams
  // (AAO). Brings vision_exam due sooner and ranks it up.
  {
    factor: "family-glaucoma",
    visitRules: ["vision_exam"],
    cadenceMultiplier: 0.5,
    priority: 1,
    reason:
      "Family history of glaucoma — earlier, more frequent eye exams (AAO)",
    source: "AAO (informational)",
  },
  // Diabetes → higher periodontal-disease risk, bidirectional with glycemic control;
  // more frequent dental visits recommended (#706). dental_cleaning base 6mo → ~3mo.
  {
    factor: "diabetes",
    visitRules: ["dental_cleaning"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason:
      "Diabetes on file — periodontal disease risk is higher; more frequent dental visits recommended",
    source: "ADA / AAP (informational)",
  },
  // Current smoking → major periodontal risk factor (#706). Tightens dental_cleaning.
  {
    factor: "current-smoking",
    visitRules: ["dental_cleaning"],
    cadenceMultiplier: 0.5,
    priority: 2,
    reason: "Current smoking — elevated periodontal risk",
    source: "ADA / AAP (informational)",
  },

  // ---- Hereditary-risk screening cadence (#711, #707 Phase 2) -------------------
  // A stored PATHOGENIC / likely-pathogenic `hereditary-risk` variant (#709) in a
  // gene with an ESTABLISHED screening guideline is a stronger, screening-actionable
  // signal than family history, so it TIGHTENS the relevant screening's cadence (via
  // screeningCadenceRules → screeningModulationFor) and explains WHY in a calm, cited
  // line — the SAME modulation mechanism the family-history/condition factors use, a
  // new input class rather than a second cadence engine (#707 substrate reuse). The
  // exclusion discipline lives one layer up: only the curated HEREDITARY_GENE_FACTORS
  // genes activate these factors at all, so a predictive-only variant (APOE ε4,
  // Huntington) never reaches this table — stored factually, ZERO cadence, ZERO risk
  // text (the #711 product constraint). Priority 3 ranks these above the priority-2
  // condition/family factors, reflecting the stronger signal. Reasons are the ONLY
  // place the "earlier + more frequent" guidance is expressed (mammography's breast-
  // MRI consideration is folded into the reason, NOT a fabricated preventive rule).
  {
    factor: "hereditary-breast-cancer",
    screeningCadenceRules: ["mammography"],
    cadenceMultiplier: 0.5,
    priority: 3,
    reason:
      "BRCA pathogenic variant on file — earlier, more frequent breast screening (mammography + breast MRI) recommended (NCCN)",
    source: "NCCN (informational)",
  },
  {
    factor: "hereditary-colorectal-cancer",
    screeningCadenceRules: ["colorectal_cancer"],
    cadenceMultiplier: 0.5,
    priority: 3,
    reason:
      "Lynch syndrome variant on file — earlier, more frequent colorectal screening (colonoscopy) recommended (NCCN)",
    source: "NCCN (informational)",
  },
  {
    factor: "familial-hypercholesterolemia",
    screeningCadenceRules: ["lipid_screening"],
    cadenceMultiplier: 0.5,
    priority: 3,
    reason:
      "Familial hypercholesterolemia variant on file — earlier, more frequent lipid screening recommended (AHA/NLA)",
    source: "AHA / NLA (informational)",
  },

  // ---- Immunization priority (issue #553) --------------------------------------
  // The immunization arm of #517: the same curated risk factors that tighten a
  // retest / rank a screening also rank up the vaccines ACIP flags for a person
  // with that factor, so a risk-elevated DUE/OVERDUE vaccine leads within its band
  // on Upcoming, the immunization page, the attention card, and the digest. These
  // rules carry ONLY an `immunizationCodes` target (cadenceMultiplier 1, no
  // analyte/screening keys), so they feed immunizationPriorityFor alone. Deliberately
  // conservative + informational, mirroring the screening rules' discipline; each
  // factor targets only the vaccines with a clear ACIP indication for it. A code is
  // ranked up only when it actually surfaces as due (an age-inappropriate one, e.g.
  // adult childhood-PCV, is already `not_recommended` per #552 and never appears).
  //
  // Immunocompromising conditions / asplenia / functional-asplenia → pneumococcal
  // and meningococcal are indicated regardless of the age-based routine.
  {
    factor: "immunocompromised",
    immunizationCodes: ["pneumo_adult", "pcv", "menacwy", "menb"],
    cadenceMultiplier: 1,
    priority: 2,
    reason: "Immunocompromised",
    source: "ACIP (informational)",
  },
  // On dialysis (advanced kidney disease) → pneumococcal + meningococcal as above,
  // plus Hepatitis B (hemodialysis patients are a core ACIP HepB indication, with a
  // higher-dose/added-dose schedule).
  {
    factor: "dialysis",
    immunizationCodes: ["pneumo_adult", "pcv", "menacwy", "menb", "hepb"],
    cadenceMultiplier: 1,
    priority: 2,
    reason: "On dialysis",
    source: "ACIP (informational)",
  },
  // Healthcare personnel → Hepatitis B, annual influenza, and documented MMR /
  // varicella immunity (ACIP HCP schedule).
  {
    factor: "healthcare-worker",
    immunizationCodes: ["hepb", "influenza", "mmr", "varicella"],
    cadenceMultiplier: 1,
    priority: 2,
    reason: "Healthcare worker",
    source: "ACIP (informational)",
  },
  // Pregnancy → Tdap in EACH pregnancy (27–36 weeks) and influenza (any trimester).
  {
    factor: "pregnant",
    immunizationCodes: ["tdap", "influenza"],
    cadenceMultiplier: 1,
    priority: 2,
    reason: "Pregnancy",
    source: "ACIP / ACOG (informational)",
  },
];

// Whether a rule targets the given analyte (by exact canonical name or substring).
function ruleMatchesAnalyte(rule: RiskRule, canonicalName: string): boolean {
  const n = canonicalName.trim().toLowerCase();
  if (rule.names?.includes(n)) return true;
  if (rule.nameContains?.some((s) => n.includes(s))) return true;
  return false;
}

// A single calm reason line PLUS its informational citation — the structured,
// citation-carrying form of the `reasons: string[]` lines (issue #656). The digest/
// hero/flag surfaces carry these as `Reason`s (code `risk-elevated`) so the "why
// sooner" travels as data, not a flattened string. `reasons` stays the text-only
// projection every existing consumer already reads; `sourced` is the parallel
// carrier, same order.
export interface SourcedReason {
  text: string;
  source: string;
}

// The combined modulation applied to a retest item. `multiplier` is the TIGHTEST
// matched multiplier (min — the most cautious cadence wins); `priority` is the
// highest matched weight (0 when nothing matched); `reasons` are the unique calm
// lines, ordered by descending priority then insertion; `sourced` is the SAME lines
// paired with their citation (issue #656), same order.
export interface RetestModulation {
  multiplier: number;
  priority: number;
  reasons: string[];
  sourced: SourcedReason[];
}

export const NO_MODULATION: RetestModulation = {
  multiplier: 1,
  priority: 0,
  reasons: [],
  sourced: [],
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
  return {
    multiplier,
    priority,
    reasons,
    sourced: uniqueReasonsSourced(matched),
  };
}

// The priority + reasons a screening rule earns from the active factors (no
// cadence side — the screening catalog interval is unchanged; this only ranks and
// explains). priority 0 with no reasons when nothing matched. `sourced` is the
// citation-carrying twin of `reasons` (issue #656), same order.
export function screeningPriorityFor(
  ruleKey: string,
  factors: ReadonlySet<RiskFactor>
): { priority: number; reasons: string[]; sourced: SourcedReason[] } {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && r.screeningRules?.includes(ruleKey)
  );
  if (matched.length === 0) return { priority: 0, reasons: [], sourced: [] };
  return {
    priority: Math.max(...matched.map((r) => r.priority)),
    reasons: uniqueReasons(matched),
    sourced: uniqueReasonsSourced(matched),
  };
}

// The cadence modulation + priority + reasons a recurring VISIT rule earns from the
// active factors (Substrate 3, #707). Mirrors retestModulationFor but keyed on
// `visitRules` (a visit rule has no analyte name): `multiplier` is the TIGHTEST
// matched multiplier (min — the most cautious cadence wins), `priority` the highest
// weight, `reasons` the unique calm lines. NO_MODULATION (multiplier 1, priority 0)
// when nothing matched, so a routine visit keeps its catalog cadence untouched. The
// pure preventive assessor applies `multiplier` to the visit interval; the generator
// surfaces `reasons`/`priority` on the item. `ruleKey` is a PreventiveRule.key.
export function visitModulationFor(
  ruleKey: string,
  factors: ReadonlySet<RiskFactor>
): RetestModulation {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && r.visitRules?.includes(ruleKey)
  );
  if (matched.length === 0) return NO_MODULATION;
  return {
    multiplier: Math.min(...matched.map((r) => r.cadenceMultiplier)),
    priority: Math.max(...matched.map((r) => r.priority)),
    reasons: uniqueReasons(matched),
    sourced: uniqueReasonsSourced(matched),
  };
}

// The cadence modulation + priority + reasons a SCREENING rule earns from the active
// factors' hereditary-risk cadence rules (#711). Mirrors visitModulationFor but keyed
// on `screeningCadenceRules`: a pathogenic hereditary-cancer / FH variant tightens the
// screening's from-last interval (`multiplier` = the TIGHTEST matched, min), ranks it
// (`priority` = the highest), and explains it (`reasons`). NO_MODULATION (multiplier 1,
// priority 0) when nothing matched, so an ordinary screening keeps its catalog cadence
// AND its priority-only `screeningRules` ranking (screeningPriorityFor) untouched — the
// two dimensions are additive. `ruleKey` is a PreventiveRule.key.
export function screeningModulationFor(
  ruleKey: string,
  factors: ReadonlySet<RiskFactor>
): RetestModulation {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && r.screeningCadenceRules?.includes(ruleKey)
  );
  if (matched.length === 0) return NO_MODULATION;
  return {
    multiplier: Math.min(...matched.map((r) => r.cadenceMultiplier)),
    priority: Math.max(...matched.map((r) => r.priority)),
    reasons: uniqueReasons(matched),
    sourced: uniqueReasonsSourced(matched),
  };
}

// The priority + reasons a vaccine earns from the active factors (issue #553).
// Mirrors screeningPriorityFor: no cadence side — this only ranks a due/overdue
// vaccine up within its band and explains WHY in a calm line. priority 0 with no
// reasons when nothing matched. `sourced` is the citation-carrying twin of `reasons`
// (issue #656). `code` is a catalog vaccine code (VaccineEntry.code).
export function immunizationPriorityFor(
  code: string,
  factors: ReadonlySet<RiskFactor>
): { priority: number; reasons: string[]; sourced: SourcedReason[] } {
  const matched = RISK_RULES.filter(
    (r) => factors.has(r.factor) && r.immunizationCodes?.includes(code)
  );
  if (matched.length === 0) return { priority: 0, reasons: [], sourced: [] };
  return {
    priority: Math.max(...matched.map((r) => r.priority)),
    reasons: uniqueReasons(matched),
    sourced: uniqueReasonsSourced(matched),
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

// The citation-carrying twin of uniqueReasons (issue #656): the SAME dedup (by
// reason text) and SAME order (descending priority, then insertion), each line
// paired with its rule's informational `source`. Kept parallel so `reasons` and
// `sourced` never drift in content or order.
function uniqueReasonsSourced(rules: RiskRule[]): SourcedReason[] {
  const seen = new Set<string>();
  const out: SourcedReason[] = [];
  for (const r of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (!seen.has(r.reason)) {
      seen.add(r.reason);
      out.push({ text: r.reason, source: r.source });
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
