// Derived clinical indices as VIRTUAL biomarkers (issue #40).
//
// Several standard cardio-metabolic / renal indices are pure functions of labs a
// user already has — computing them saves the user arithmetic and surfaces a
// trend they'd otherwise never see. We compute them at READ time from the stored
// component readings; nothing is written to the database, so there are no
// stored-row / de-dup / staleness questions and a component edit re-derives for
// free on the next read.
//
// Every index declares its input analytes by CANONICAL name + canonical unit, so
// component readings reported in any unit (the classic mg/dL vs mmol/L split) are
// converted to the canonical unit BEFORE the formula runs — the ratios/indices are
// only correct in one unit system (a TG/HDL ratio computed from mmol/L values is
// NOT the mg/dL ratio, because TG and HDL have different molar masses). The unit
// tests exercise both systems per index for exactly this reason.
//
// Pairing rule: an index is computed for a draw only when every input has a
// reading on the SAME date (same blood draw), or — for a loosened `windowDays` —
// the nearest input reading within that window of the anchor draw. Same-draw
// pairing is the safe default: mixing components from different draws would invent
// an index value that never existed. eGFR/HOMA-IR additionally require
// demographics (age/sex) and are simply not produced when those are unknown —
// never guessed.
//
// This module is PURE (no DB, no network): the query layer feeds it the stored
// component series + a demographics resolver and turns the results into virtual
// records. That keeps the math unit-testable in isolation.

import { convertToCanonical } from "./unit-conversions";
import type { Sex } from "./types";
import { ADULT_MIN_AGE, isAdultForClinical } from "./life-stage";

// The canonical output names — each MUST exist as a canonical_biomarkers row so
// the shared reference/optimal-range + flag machinery treats a derived value like
// any other analyte (ranges, badges, digest classification).
export const DERIVED_NAMES = [
  "Non-HDL Cholesterol",
  "Cholesterol/HDL Ratio",
  "LDL/HDL Ratio",
  "Triglyceride/HDL Ratio",
  "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
  "Estimated Glomerular Filtration Rate (eGFR)",
  "PhenoAge",
  "Microalbumin/Creatinine Ratio, Urine",
  "HDL as % of Cholesterol",
  "Protein/Creatinine Ratio, Urine",
  "Omega-6 Total",
] as const;
export type DerivedName = (typeof DERIVED_NAMES)[number];

// A raw component reading as it comes off the stored series: a numeric value in
// some (possibly missing) unit, on a date. `value` is the number the reading
// contributes — the exact medical_records.value_num, or, for a CENSORED reading
// ("<0.2", ">10"), the detection limit it was substituted at, in which case `bound`
// carries the censoring marker. The app's convention for a censored lab value is
// "substitute the limit, keep the marker, show it" (lib/reference-range/parsing —
// parseLooseValue / plottableReadingValue, which the charts already consume), and
// this file follows it: the limit is what the arithmetic uses, and `bound` travels
// through to the derived reading so a single computed number can never present a
// censored input as an exact one. A purely qualitative reading has no number at all
// and never reaches here.
export interface ComponentReading {
  date: string; // YYYY-MM-DD
  value: number;
  unit: string | null;
  // Set when `value` is a substituted detection limit: "<" = the true value is BELOW
  // it (below-detection), ">" = ABOVE it.
  bound?: "<" | ">";
}

// Demographics needed by demographic-dependent indices (eGFR). `ageOn` resolves
// the subject's whole-year age on a given draw date (birthdate-derived, else the
// stored age) or null when unknown; `sex` is the profile's sex or null. Both null
// paths make eGFR decline to compute rather than guess.
export interface DerivedDemographics {
  sex: Sex | null;
  ageOn: (date: string) => number | null;
}

// The direction of the error a CENSORED (substituted-at-the-limit) component puts
// into a derived value: "over" = the computed result can only be too HIGH from that
// term, "under" = too low. Null when the index has not declared how its inputs move
// it, or when several censored inputs disagree — an unstated direction is honest,
// an assumed one is not.
export type CensoredBias = "over" | "under";

// What a derived reading says about resting on censored components: which inputs were
// substituted at a limit (and in which direction the limit was), plus the direction of
// the error that puts into the result when the index has declared it.
export interface CensoredSummary {
  inputs: { name: string; label: string; bound: "<" | ">" }[];
  bias: CensoredBias | null;
}

// ── PhenoAge leave-one-out effects (#2366) ────────────────────────────────────
//
// "Which of these inputs is moving my number, and by how much?" is a question about
// the PhenoAge COMPUTATION, not about a page, so it is answered here, once, beside
// the formula — both bio-age surfaces format this one result.
//
// The definition matters more than the arithmetic. A term's share of the linear
// predictor `xb` is the obvious decomposition and it is WRONG in a way that looks
// plausible: `xb` reaches years through a Gompertz mortality transform, so a term's
// share of `xb` is not its share of the years; CRP enters as ln(CRP), so a linear
// share misstates its scale; and chronological age is itself a term, usually the
// dominant one. What is reported instead is a COUNTERFACTUAL in years — re-run the
// whole model with ONE input moved to a stated reference value and report the
// difference — which handles the log and age terms correctly for free because the
// transform runs end to end each time.

// Where an input's reference value came from. "optimal"/"reference" are the curated
// bands (resolved by the caller, which owns the dataset read); "model-floor" is the
// chronological-age row, whose reference is the youngest age this model is applied
// at (PHENOAGE_MIN_AGE) — there is no curated "optimal age" and inventing one would
// be worse than naming the model's own boundary.
export type PhenoAgeReferenceBasis = "optimal" | "reference" | "model-floor";

// A reference value for one input, in that input's CANONICAL unit (years for age).
export interface PhenoAgeReference {
  value: number;
  basis: PhenoAgeReferenceBasis;
}

// What one input contributes to a PhenoAge, as a counterfactual in years.
export interface PhenoAgeInputEffect {
  // The input's key (its preferred canonical name), or AGE_INPUT_KEY for the
  // chronological-age term.
  key: string;
  // The canonical name the value ACTUALLY came from (which glucose spelling the draw
  // carried), so a surface links to the series it was read out of.
  name: string;
  // The short formula token ("CRP", "RDW", "Age").
  label: string;
  // The profile's own value, in the input's canonical unit, and its unit.
  value: number;
  unit: string;
  // Set when `value` is a substituted detection limit — the effect computed FROM a
  // censored value is itself bounded, and a surface must say so rather than present
  // it as exact.
  bound?: "<" | ">";
  // The value the counterfactual moved this input TO, or null when nothing curated
  // states one (an analyte with neither an optimal nor a reference band).
  reference: PhenoAgeReference | null;
  // Years this input ADDS to the result relative to its reference: positive = the
  // number reads this much higher than it would with the input at reference,
  // negative = this much lower. NULL — never 0 — when there is no reference to
  // compare against, or when the counterfactual model run is undefined. An absent
  // comparison must never read as "this input does nothing".
  effectYears: number | null;
}

// The chronological-age term's key. Not a canonical analyte — it is the model's tenth
// input, and it is shown in the same ranked list rather than hidden, because it is
// usually the dominant term and seeing that is what stops the number being read as a
// verdict on the labs alone.
export const AGE_INPUT_KEY = "Chronological age";

// One computed derived reading. `value` is already rounded to the index's display
// precision; `unit` is the canonical output unit; `formula` is a human-readable
// expression with the actual component values substituted, for the "derived"
// subtitle/tooltip; `inputs` lists the canonical-unit component values used.
export interface DerivedReading {
  name: DerivedName;
  date: string;
  value: number;
  // The canonical OUTPUT unit — mirroring the index's canonical_biomarkers row, so a
  // computed reading is labelled exactly like a lab-reported one of the same analyte.
  // Null for an index whose canonical entry carries no unit (a dimensionless ratio the
  // curated dataset records as unitless); convertToCanonical treats a null canonical
  // unit as "already canonical", so the flag still derives.
  unit: string | null;
  formula: string;
  // The component values used, in input order. `name` is the canonical name the value
  // ACTUALLY came from (which sibling matched, for an input that accepts several), and
  // `bound` is set when that component was censored and substituted at its limit.
  inputs: { name: string; value: number; unit: string; bound?: "<" | ">" }[];
  // Present only when ≥1 component was censored. A single number cannot show a "<"
  // the way a chart dot can, so the censoring is carried on the reading itself and
  // every surface that renders the number says which input it rests on.
  censored?: CensoredSummary;
  // PhenoAge only, and only when the caller supplied a reference resolver: each input
  // ranked by how many years it moves this reading (#2366). Computed HERE, in the same
  // pass and from the same exact component values that produced `value`, so the
  // decomposition and the number can never disagree.
  effects?: PhenoAgeInputEffect[];
}

interface InputSpec {
  // The canonical analyte name(s) this input accepts (each must match a
  // canonical_biomarkers row) — also the keys the query layer reads stored series for.
  //
  // A LIST is an ordered PREFERENCE, first match on the draw wins, and it is a claim
  // made by THIS formula about THIS input only (#2334): the curated dataset carries
  // "Glucose", "Glucose, Fasting" and "Glucose, Gestational Screen (50 g)" as distinct
  // entries because they are genuinely different measurements, so nothing here folds
  // their identities — reference bands, flags, retest clocks and charts keep treating
  // them as separate analytes. Keeping the acceptance list ON the input confines the
  // interchangeability to the one index entitled to assert it.
  //
  // The FIRST name is also the input's key: the key `compute()` reads its value under,
  // the name the completeness checklist asks for, and the label a formula string uses.
  canonical: string | readonly string[];
  // The canonical unit the formula expects the value in; readings in other units
  // are converted to this via lib/unit-conversions before the formula runs.
  unit: string;
  // Short token used in the human formula string (e.g. "Total", "HDL").
  label: string;
}

// The canonical names an input accepts, in preference order.
function inputAccepts(spec: InputSpec): readonly string[] {
  return typeof spec.canonical === "string" ? [spec.canonical] : spec.canonical;
}

// An input's KEY: its preferred canonical name (see InputSpec.canonical).
function inputKey(spec: InputSpec): string {
  return inputAccepts(spec)[0];
}

interface DerivedDef {
  name: DerivedName;
  unit: string | null; // canonical output unit (null = the canonical row is unitless)
  decimals: number; // display precision for the computed value
  inputs: InputSpec[];
  // A generic caption of the formula (no values), e.g. "Total − HDL".
  formulaLabel: string;
  needsSex?: boolean;
  needsAge?: boolean;
  // Which way each input moves the result — "+" a higher component value raises the
  // index, "-" lowers it — keyed by input key. STATED PER INDEX rather than assumed:
  // it is only consulted to say which way a CENSORED component's substituted limit
  // biases the number, and an index that has not declared it makes no directional
  // claim at all (the reading still says it rests on a censored input).
  inputDirection?: Record<string, "+" | "-">;
  // Compute the raw (unrounded) index from the canonical-unit component values
  // (keyed by canonical name) and demographics for the draw date. Return null when
  // the value is undefined/non-finite (e.g. divide-by-zero, missing demographics).
  compute: (
    vals: Record<string, number>,
    demo: DerivedDemographics,
    date: string
  ) => number | null;
}

// Round to `decimals` places, guarding against -0 and non-finite results.
function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

// CKD-EPI 2021 creatinine equation (race-free). Serum creatinine in mg/dL, age in
// whole years, sex male/female. Returns mL/min/1.73m². Reference: Inker LA et al.,
// "New Creatinine- and Cystatin C-Based Equations to Estimate GFR without Race",
// N Engl J Med 2021;385:1737. Race-free by design.
export function ckdEpi2021(
  creatinineMgDl: number,
  age: number,
  sex: "male" | "female"
): number {
  const female = sex === "female";
  const kappa = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const ratio = creatinineMgDl / kappa;
  const egfr =
    142 *
    Math.min(ratio, 1) ** alpha *
    Math.max(ratio, 1) ** -1.2 *
    0.9938 ** age *
    (female ? 1.012 : 1);
  return egfr;
}

// ── PhenoAge (Levine 2018) ────────────────────────────────────────────────────
//
// Levine's Phenotypic Age: a "biological age" (in years) estimated from nine
// routine clinical analytes plus chronological age, via a mortality-risk model.
// Reference: Levine ME, Lu AT, Quach A, et al. "An epigenetic biomarker of aging
// for lifespan and healthspan." Aging (Albany NY). 2018;10(4):573–591.
// doi:10.18632/aging.101414 — the linear predictor + Gompertz mortality→age
// conversion are given in the paper's Methods / supplement (developed and
// validated in NHANES III/IV adults, ages ~20–84).
//
// STEP 1 — the mortality-score linear predictor `xb`. The published coefficients
// assume EACH analyte in a SPECIFIC unit (NOT the app's canonical unit in every
// case), so the compute() below converts each canonical value to the formula's
// expected unit BEFORE calling this function. This function takes values ALREADY
// in the formula units documented per-parameter:
//   albuminGL       Albumin,               g/L
//   creatinineUmolL Creatinine,            µmol/L
//   glucoseMmolL    Glucose (fasting),     mmol/L
//   crpMgDl         hs-CRP,                mg/dL  (then natural-log transformed)
//   lymphocytePct   Lymphocytes,           % of WBC
//   mcvFl           Mean Corpuscular Vol., fL
//   rdwPct          RDW,                   %
//   alpUL           Alkaline Phosphatase,  U/L
//   wbcThousandUl   WBC count,             1000 cells/µL (== 10^9 cells/L)
//   ageYears        Chronological age,     years
//
// STEP 2 — convert `xb` (a 10-year / 120-month Gompertz mortality hazard) to a
// phenotypic age in years using the published constants (gamma = 0.0076927,
// 141.50225, 0.090165, 0.00553). These are fixed model constants, not tunables.
//
// INFORMATIONAL, NOT MEDICAL ADVICE. This is a population-level estimate with
// several years of error; it does not carry day-level precision.
const PHENOAGE_GAMMA = 0.0076927; // Gompertz shape parameter (per month)
const PHENOAGE_TT = 120; // evaluation horizon, months (10-year mortality)

export function phenoAge(input: {
  albuminGL: number;
  creatinineUmolL: number;
  glucoseMmolL: number;
  crpMgDl: number;
  lymphocytePct: number;
  mcvFl: number;
  rdwPct: number;
  alpUL: number;
  wbcThousandUl: number;
  ageYears: number;
}): number | null {
  // ln(CRP) is undefined at/below zero (a below-detection or absent hs-CRP); we
  // decline rather than invent a value or clamp to an arbitrary floor.
  if (!(input.crpMgDl > 0)) return null;

  const xb =
    -19.907 -
    0.0336 * input.albuminGL +
    0.0095 * input.creatinineUmolL +
    0.1953 * input.glucoseMmolL +
    0.0954 * Math.log(input.crpMgDl) -
    0.012 * input.lymphocytePct +
    0.0268 * input.mcvFl +
    0.3306 * input.rdwPct +
    0.00188 * input.alpUL +
    0.0554 * input.wbcThousandUl +
    0.0804 * input.ageYears;

  const g = PHENOAGE_GAMMA;
  // 10-year mortality risk under the Gompertz model.
  const mort =
    1 - Math.exp((-Math.exp(xb) * (Math.exp(g * PHENOAGE_TT) - 1)) / g);
  // Mortality → phenotypic age (years). 1 - mort must be in (0,1) for the logs.
  if (!(mort > 0) || !(mort < 1)) return null;
  const pheno = 141.50225 + Math.log(-0.00553 * Math.log(1 - mort)) / 0.090165;
  return Number.isFinite(pheno) ? pheno : null;
}

// Per-parameter unit conversions from the app's CANONICAL storage unit to the
// PhenoAge FORMULA unit (see phenoAge() above). Documented with molar masses so a
// reviewer can verify each factor against the Levine 2018 unit assumptions.
const ALBUMIN_GDL_TO_GL = 10; // g/dL → g/L
const CREATININE_MGDL_TO_UMOLL = 88.4017; // mg/dL → µmol/L (MW 113.12 g/mol)
const GLUCOSE_MGDL_TO_MMOLL = 1 / 18.0182; // mg/dL → mmol/L (MW 180.156 g/mol)
const CRP_MGL_TO_MGDL = 1 / 10; // mg/L → mg/dL
// WBC 10^3/µL is numerically identical to 10^9/L (the formula's unit); no factor.

// PhenoAge from the app's CANONICAL-unit component values, keyed by input key — the
// ONE place the canonical→formula unit conversions above are applied. Both callers go
// through it: the spec's compute() (which produces the reading) and the leave-one-out
// decomposition (which re-runs it with one value swapped), so a counterfactual can
// never be evaluated by a second, drifting copy of the model.
function phenoAgeFromCanonical(
  v: Record<string, number>,
  ageYears: number
): number | null {
  return phenoAge({
    albuminGL: v["Albumin"] * ALBUMIN_GDL_TO_GL,
    creatinineUmolL: v["Creatinine"] * CREATININE_MGDL_TO_UMOLL,
    // Keyed by the input's PREFERRED name (see InputSpec.canonical) — the value is
    // whichever accepted glucose entry the draw actually carried.
    glucoseMmolL: v["Glucose, Fasting"] * GLUCOSE_MGDL_TO_MMOLL,
    crpMgDl:
      v["High-Sensitivity C-Reactive Protein (hs-CRP)"] * CRP_MGL_TO_MGDL,
    lymphocytePct: v["Lymphocytes, Relative"],
    mcvFl: v["Mean Corpuscular Volume (MCV)"],
    rdwPct: v["Red Cell Distribution Width (RDW)"],
    alpUL: v["Alkaline Phosphatase"],
    wbcThousandUl: v["White Blood Cell Count"],
    ageYears,
  });
}

// PhenoAge is developed/validated in ADULTS (NHANES III/IV, ages ~20–84); it is
// not meaningful for children, so — like every adult-population surface — the deriver
// emits NOTHING below the adult floor. This is the SAME line (ADULT_MIN_AGE from the
// one age model, lib/life-stage) that fitness norms, the bio-age hero, and — since
// #490 — eGFR gate on, so the adult-population indices no longer disagree on the
// pediatric floor. Aliased here so the bio-age surfaces keep their import name.
export const PHENOAGE_MIN_AGE = ADULT_MIN_AGE;

// The catalogue of derived indices. Ordered for stable output. Each formula runs
// on values already converted to the input's canonical unit.
const DERIVED_DEFS: DerivedDef[] = [
  {
    name: "Non-HDL Cholesterol",
    unit: "mg/dL",
    decimals: 0,
    formulaLabel: "Total Cholesterol − HDL",
    inputs: [
      { canonical: "Total Cholesterol", unit: "mg/dL", label: "Total" },
      { canonical: "HDL Cholesterol", unit: "mg/dL", label: "HDL" },
    ],
    compute: (v) => {
      const nonHdl = v["Total Cholesterol"] - v["HDL Cholesterol"];
      return nonHdl >= 0 ? nonHdl : null;
    },
  },
  // ── The two cholesterol ratios (#1582) ──────────────────────────────────────
  //
  // Some labs print them, some don't, so before this they appeared and disappeared
  // across a profile's history even though every input was on both reports. Both are
  // computed from the SAME mg/dL component pair the indices above already declare, so
  // they inherit this file's unit handling wholesale: each input is converted to
  // mg/dL before the division, and a reading that cannot be converted (an
  // unrecognized or wrong-dimension unit) drops out of the pairing, which declines
  // the ratio for that draw instead of dividing incomparable numbers.
  //
  // They stay SEPARATE identities (#482): different numerators, different reference
  // bands, so one ratio's in-range reading must never grant an all-clear for the
  // other. And both derive from STORED components only — LDL is frequently a lab's
  // own Friedewald calculation, and this file never chains a derivation off another
  // derivation, so a computed LDL (if one ever ships) would be an explicit, separate
  // decision rather than a silent second inference.
  {
    name: "Cholesterol/HDL Ratio",
    unit: "ratio",
    decimals: 2,
    formulaLabel: "Total Cholesterol ÷ HDL (mg/dL)",
    inputs: [
      { canonical: "Total Cholesterol", unit: "mg/dL", label: "Total" },
      { canonical: "HDL Cholesterol", unit: "mg/dL", label: "HDL" },
    ],
    compute: (v) => {
      const hdl = v["HDL Cholesterol"];
      if (hdl <= 0) return null;
      return v["Total Cholesterol"] / hdl;
    },
  },
  {
    name: "LDL/HDL Ratio",
    // The curated entry records this one as unitless ("a calculated value with no
    // units"), so the computed reading carries no unit either — a derived row is
    // labelled like a reported one of the same analyte.
    unit: null,
    decimals: 2,
    formulaLabel: "LDL ÷ HDL (mg/dL)",
    inputs: [
      { canonical: "LDL Cholesterol", unit: "mg/dL", label: "LDL" },
      { canonical: "HDL Cholesterol", unit: "mg/dL", label: "HDL" },
    ],
    compute: (v) => {
      const hdl = v["HDL Cholesterol"];
      if (hdl <= 0) return null;
      return v["LDL Cholesterol"] / hdl;
    },
  },
  {
    name: "Triglyceride/HDL Ratio",
    unit: "ratio",
    decimals: 2,
    formulaLabel: "Triglycerides ÷ HDL (mg/dL)",
    inputs: [
      { canonical: "Triglycerides", unit: "mg/dL", label: "TG" },
      { canonical: "HDL Cholesterol", unit: "mg/dL", label: "HDL" },
    ],
    // The ratio is only meaningful computed from mg/dL values (a mmol/L ratio
    // differs — different molar masses), which is why both inputs are converted to
    // mg/dL first.
    compute: (v) => {
      const hdl = v["HDL Cholesterol"];
      if (hdl <= 0) return null;
      return v["Triglycerides"] / hdl;
    },
  },
  {
    name: "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
    unit: "index",
    decimals: 2,
    formulaLabel: "(Fasting glucose mg/dL × fasting insulin µU/mL) ÷ 405",
    // The glucose input REQUIRES the fasting frame (#2357): a one-name preference
    // list, deliberately with no fallback to the unqualified entry. HOMA-IR is
    // defined on fasting glucose — the label above says so — and since #2337 the
    // unqualified "Glucose" entry is explicitly the one for a draw whose fasting
    // state is UNKNOWN, band-less precisely because neither frame can be assumed.
    // Accepting it here would be a stated contradiction: the index would assert a
    // frame the value's own canonical entry says it does not have.
    //
    // The consequence is intended, not overlooked: a draw carrying only an
    // unqualified glucose now produces NO HOMA-IR, where it used to produce one. An
    // index defined on a fasting measurement should decline rather than compute on
    // an unknown frame — the same argument that made the unqualified entry
    // band-less. This is NOT the shape of PhenoAge's ["Glucose, Fasting", "Glucose"]
    // below: Levine's model is a population mortality regression that merely PREFERS
    // the fasting analyte, whereas HOMA-IR's arithmetic is only that index on the
    // fasting frame, so the two lists differ on purpose.
    //
    // The INSULIN input requires the same frame, for the same reason (#2371). It could
    // not until "Insulin, Fasting" was coined: the vocabulary held one unqualified
    // "Insulin" entry carrying fasting BANDS and the bare note "Fasting", so the frame
    // was asserted by a note rather than by the name and there was nothing here to
    // require. That left the index half-guarded — declining on a glucose of unknown
    // frame while computing on an insulin of unknown frame — and it was the weaker
    // half that was left open: a post-prandial insulin runs several times its fasting
    // value, a far larger multiplier on (glucose × insulin) ÷ 405 than a post-prandial
    // glucose contributes. Both inputs now name the frame the label claims.
    inputs: [
      { canonical: ["Glucose, Fasting"], unit: "mg/dL", label: "Glucose" },
      { canonical: ["Insulin, Fasting"], unit: "uIU/mL", label: "Insulin" },
    ],
    compute: (v) => {
      const homa = (v["Glucose, Fasting"] * v["Insulin, Fasting"]) / 405;
      return Number.isFinite(homa) ? homa : null;
    },
  },
  {
    name: "Estimated Glomerular Filtration Rate (eGFR)",
    unit: "mL/min/1.73m2",
    decimals: 0,
    formulaLabel: "CKD-EPI 2021 (creatinine, age, sex; race-free)",
    needsSex: true,
    needsAge: true,
    inputs: [{ canonical: "Creatinine", unit: "mg/dL", label: "Creatinine" }],
    compute: (v, demo, date) => {
      const sex = demo.sex;
      const age = demo.ageOn(date);
      // Never guess: eGFR requires a known binary sex and age.
      if (sex !== "male" && sex !== "female") return null;
      // CKD-EPI 2021 is validated in ADULTS only; a child needs the bedside-Schwartz
      // equation (height-based), not this age/sex/creatinine formula, so an under-18
      // profile gets NO eGFR rather than a clinically invalid adult-formula number
      // (#490). This is the same ADULT_MIN_AGE floor PhenoAge beside it uses — the two
      // adult-population indices no longer disagree on the pediatric line.
      if (!isAdultForClinical(age)) return null;
      const scr = v["Creatinine"];
      if (!(scr > 0)) return null;
      return ckdEpi2021(scr, age, sex);
    },
  },
  {
    name: "PhenoAge",
    unit: "years",
    decimals: 1,
    formulaLabel: "Levine PhenoAge (2018): 9 analytes + age",
    needsAge: true,
    // Every input's sign in the linear predictor below (PhenoAge is increasing in xb,
    // so a term's coefficient sign IS the direction it moves the age). Read straight
    // off the published coefficients; the only thing it is used for is naming the
    // direction of a censored component's substitution bias.
    inputDirection: {
      Albumin: "-",
      Creatinine: "+",
      "Glucose, Fasting": "+",
      "High-Sensitivity C-Reactive Protein (hs-CRP)": "+",
      "Lymphocytes, Relative": "-",
      "Mean Corpuscular Volume (MCV)": "+",
      "Red Cell Distribution Width (RDW)": "+",
      "Alkaline Phosphatase": "+",
      "White Blood Cell Count": "+",
    },
    // All nine analytes required from ONE draw (no imputation). Units here are the
    // app's CANONICAL units; compute() converts each to the formula unit.
    inputs: [
      { canonical: "Albumin", unit: "g/dL", label: "Alb" },
      { canonical: "Creatinine", unit: "mg/dL", label: "Cr" },
      // Levine's PhenoAge is defined on FASTING serum glucose, so the curated
      // "Glucose, Fasting" entry — which is what a lab reporting a fasting panel
      // imports under — is the PREFERRED input, not a fallback, and the order says so
      // (#2334). A draw carrying only the unqualified "Glucose" still computes; a draw
      // carrying both uses the fasting one. Both entries are curated in mg/dL with the
      // same mmol/L factor, so the conversion is identical either way.
      {
        canonical: ["Glucose, Fasting", "Glucose"],
        unit: "mg/dL",
        label: "Glu",
      },
      {
        canonical: "High-Sensitivity C-Reactive Protein (hs-CRP)",
        unit: "mg/L",
        label: "CRP",
      },
      { canonical: "Lymphocytes, Relative", unit: "%", label: "Lym%" },
      { canonical: "Mean Corpuscular Volume (MCV)", unit: "fL", label: "MCV" },
      {
        canonical: "Red Cell Distribution Width (RDW)",
        unit: "%",
        label: "RDW",
      },
      { canonical: "Alkaline Phosphatase", unit: "U/L", label: "ALP" },
      { canonical: "White Blood Cell Count", unit: "10^3/uL", label: "WBC" },
    ],
    compute: (v, demo, date) => {
      const age = demo.ageOn(date);
      // Never guess: PhenoAge needs a known chronological age, and is adult-only.
      if (age == null || age < PHENOAGE_MIN_AGE) return null;
      return phenoAgeFromCanonical(v, age);
    },
  },
  // ── The four #2300 indices ──────────────────────────────────────────────────
  //
  // Same contract as everything above: MEASURED components only (this file never
  // chains a derivation off another derivation), same-draw pairing, canonical-unit
  // conversion before the arithmetic, and a printed value winning its draw.
  //
  // ONE-DIRECTIONAL, deliberately. Each relation below is algebraically invertible
  // (given a ratio and one component the other follows), and none of them is
  // inverted. A printed ratio carries fewer significant figures than the components
  // it came from, so backing a component out of it manufactures precision in a value
  // that was measured exactly; inversion also multiplies the places a wrong
  // same-named component can be picked, and makes the no-chaining rule unenforceable
  // since any member could be an input or an output.
  //
  // And the index that is NOT here: `Bilirubin, Indirect` (total − direct) has a
  // canonical entry but no spec, because censoring breaks the subtraction — when
  // either component is reported below the detection limit the difference is
  // undefined over a wide range, which is why labs print "Can't Calc" instead of
  // guessing. Reading it in is right; computing it is not.
  {
    name: "Microalbumin/Creatinine Ratio, Urine",
    unit: "mg/g",
    decimals: 1,
    formulaLabel: "Urine albumin (mg/dL) ÷ urine creatinine (mg/dL) × 1000",
    // The specimen is the whole game here. A panel commonly carries BOTH a serum
    // "Creatinine" and a "Creatinine, Urine", and they differ by ~100× in mg/dL — a
    // spot urine creatinine near 100 mg/dL against a serum creatinine near 1.0. Take
    // the serum one and a urine albumin of 30 mg/L reads 3000 mg/g instead of 30,
    // dropping a normal result deep inside albuminuria staging. The per-input
    // `canonical` declaration is the guard: it is an EXACT canonical-name lookup into
    // the caller's series map, so the serum entry is a different key and can never be
    // substituted. It must never be relaxed into a stem or fuzzy match — an input that
    // accepts a sibling (#2334) still ENUMERATES it by exact name, one input at a time.
    //
    // Urine albumin is declared in the CANONICAL dataset unit (mg/dL), not the mg/L a
    // lab usually prints. Both give the identical mg/g for any reading that carries a
    // unit — convertToCanonical rescales mg/L by 0.1 first — but they differ for a
    // reading with NO unit, which convertToCanonical passes through as "already
    // canonical". Declaring the analyte's own canonical unit keeps that assumption
    // the SAME one the entry's flag path makes; declaring mg/L here would make this
    // module and the dataset disagree about what an unlabelled urine albumin means,
    // and read it 10× low. (Same reasoning as PhenoAge above, which declares each
    // input in the app's canonical unit and converts to the formula's unit inside
    // compute().)
    inputs: [
      { canonical: "Albumin, Urine", unit: "mg/dL", label: "Alb" },
      { canonical: "Creatinine, Urine", unit: "mg/dL", label: "UCr" },
    ],
    // mg/dL ÷ mg/dL is dimensionless; ×1000 turns mg of albumin per mg of creatinine
    // into mg per GRAM, the unit KDIGO's albuminuria categories are written in.
    compute: (v) => {
      const cr = v["Creatinine, Urine"];
      if (cr <= 0) return null;
      return (v["Albumin, Urine"] / cr) * 1000;
    },
  },
  {
    name: "HDL as % of Cholesterol",
    unit: "%",
    decimals: 1,
    formulaLabel: "HDL ÷ Total Cholesterol × 100 (mg/dL)",
    inputs: [
      { canonical: "Total Cholesterol", unit: "mg/dL", label: "Total" },
      { canonical: "HDL Cholesterol", unit: "mg/dL", label: "HDL" },
    ],
    compute: (v) => {
      const total = v["Total Cholesterol"];
      if (total <= 0) return null;
      return (v["HDL Cholesterol"] / total) * 100;
    },
  },
  {
    name: "Protein/Creatinine Ratio, Urine",
    unit: "mg/g",
    decimals: 1,
    formulaLabel: "Urine protein (mg/dL) ÷ urine creatinine (mg/dL) × 1000",
    // `Protein, Urine`'s canonical entry is UNITLESS — it is curated as the
    // qualitative dipstick pad (Negative/Trace/1+), and convertToCanonical treats a
    // null canonical unit as "already canonical". So a mg/dL row and a mg/L row would
    // BOTH pass through unconverted and divide incomparably, 10× apart, with nothing
    // in the output saying which one it was. The input unit is declared HERE rather
    // than stamped onto the dataset entry: the entry describes a pad reading that
    // genuinely has no unit, and a unit there would assert mg/dL for every unitless
    // dipstick row everywhere in the app, while this declaration confines the
    // assumption to the one place that does arithmetic. Purely qualitative rows never
    // reach the formula at all — the query layer drops anything without a numeric
    // value (componentNumeric).
    inputs: [
      { canonical: "Protein, Urine", unit: "mg/dL", label: "Prot" },
      { canonical: "Creatinine, Urine", unit: "mg/dL", label: "UCr" },
    ],
    compute: (v) => {
      const cr = v["Creatinine, Urine"];
      if (cr <= 0) return null;
      return (v["Protein, Urine"] / cr) * 1000;
    },
  },
  {
    name: "Omega-6 Total",
    unit: "% by wt",
    decimals: 1,
    formulaLabel: "Omega-6/Omega-3 ratio × omega-3 total (% by wt)",
    // NOT the sum of the itemized omega-6 lines. Arachidonic + linoleic is the
    // obvious derivation and it is quietly WRONG: the printed total also counts DGLA
    // and the minor omega-6 species the panel does not itemize, so the sum
    // understates it by several points — a shortfall observed against a real report,
    // and invisible in the output because it still looks like a plausible total. The
    // ratio route reproduces the printed value because the ratio's own numerator IS
    // that total.
    inputs: [
      { canonical: "Omega-6/Omega-3 Ratio", unit: "ratio", label: "n6:n3" },
      {
        canonical: "Omega-3 Total (OmegaCheck)",
        unit: "% by wt",
        label: "n-3",
      },
    ],
    compute: (v) => {
      const ratio = v["Omega-6/Omega-3 Ratio"];
      const omega3 = v["Omega-3 Total (OmegaCheck)"];
      if (ratio <= 0 || omega3 <= 0) return null;
      return ratio * omega3;
    },
  },
];

export const DERIVED_DEFS_BY_NAME: Record<DerivedName, DerivedDef> =
  Object.fromEntries(DERIVED_DEFS.map((d) => [d.name, d])) as Record<
    DerivedName,
    DerivedDef
  >;

// The canonical input analytes any derived index depends on — the set of series
// the query layer must load to compute all indices. Includes every ACCEPTED sibling
// of every input, since any of them can be the value an index consumes.
export function derivedInputCanonicalNames(): string[] {
  const s = new Set<string>();
  for (const d of DERIVED_DEFS)
    for (const i of d.inputs) for (const n of inputAccepts(i)) s.add(n);
  return [...s];
}

// The input SLOTS of ONE derived index: each slot's key (its preferred canonical
// name) and the canonical names THAT INDEX accepts for it, in spec order. The query
// layer uses this to decide whether a profile HAS an input — a slot is present when
// any accepted name is — without re-deriving the preference rule.
//
// PER INDEX, and that is the whole point (#2372). This used to key slots ACROSS
// indices and union their acceptance lists, which stayed a no-op only while no two
// indices shared a key with different lists. #2357 ended that: HOMA-IR and PhenoAge
// both key glucose on "Glucose, Fasting" while accepting different lists (PhenoAge
// falls back to the unqualified entry, HOMA-IR declines on it), so the shared slot
// reported PRESENT for a profile holding only "Glucose" — true for PhenoAge, false
// for HOMA-IR, and one slot cannot be honest about both. It happened to be right for
// the single consumer, which asks about PhenoAge and whose list the union therefore
// was; #2371 adds a second frame-specific input to the same index, and "correct by
// coincidence of there being one consumer" is not a property worth keeping.
//
// "Is this slot filled?" has no answer independent of WHICH index is asking, so the
// index is now an argument rather than something the caller is trusted to remember.
export function derivedInputSlots(name: DerivedName): {
  key: string;
  accepts: readonly string[];
}[] {
  const def = DERIVED_DEFS_BY_NAME[name];
  if (!def) return [];
  return def.inputs.map((i) => ({
    key: inputKey(i),
    accepts: inputAccepts(i),
  }));
}

// Which of ONE index's input slots a profile has a usable reading for, given a
// predicate over canonical names. The presence RULE — a slot counts as filled when
// any name that index accepts for it has a reading — lives here beside the specs
// rather than at each call site.
export function presentInputKeysFor(
  name: DerivedName,
  hasReading: (canonical: string) => boolean
): Set<string> {
  const present = new Set<string>();
  for (const slot of derivedInputSlots(name))
    if (slot.accepts.some(hasReading)) present.add(slot.key);
  return present;
}

// The input KEYS of ONE derived index (preferred canonical name per input, in spec
// order), or [] when `name` isn't a derived index. This is the index's checklist
// vocabulary — one entry per input, never one per accepted spelling.
export function derivedInputKeysFor(name: string): string[] {
  const def = DERIVED_DEFS_BY_NAME[name as DerivedName];
  return def ? def.inputs.map(inputKey) : [];
}

// The CANONICAL UNIT each input of one derived index is declared in, keyed by input
// key. A caller comparing a curated band against an input's value has to state it in
// the same unit the formula consumes — the dataset entry's own unit is not always
// that unit — so the declaration is read from here rather than re-guessed.
export function derivedInputUnitsFor(name: string): Record<string, string> {
  const def = DERIVED_DEFS_BY_NAME[name as DerivedName];
  if (!def) return {};
  return Object.fromEntries(def.inputs.map((i) => [inputKey(i), i.unit]));
}

// The canonical input analytes ONE derived index depends on, or [] when `name`
// isn't a derived index. The retest clock (#482 scope 2) uses this: a derived
// value's retest is satisfied when its INPUTS are fresh — a stored Non-HDL is not
// "overdue" while a recent Total + HDL exist — because re-drawing the inputs
// re-derives it. The input→derived relation is a family the clock honors.
// Every accepted spelling is listed: a fresh "Glucose, Fasting" satisfies PhenoAge's
// glucose input exactly as a fresh "Glucose" does, so the clock must see both.
export function derivedInputCanonicalNamesFor(name: string): string[] {
  const def = DERIVED_DEFS_BY_NAME[name as DerivedName];
  return def ? def.inputs.flatMap((i) => [...inputAccepts(i)]) : [];
}

// One component value resolved for a draw: the canonical-unit number, the canonical
// name it came from, and the censoring marker when it is a substituted limit.
interface ResolvedComponent {
  value: number;
  name: string;
  bound?: "<" | ">";
}

// Reduce ONE accepted canonical name's series to date -> resolved value, converting
// each reading to the input's canonical unit and dropping readings that can't be
// converted. The conversion is keyed by the reading's OWN canonical name, so a
// sibling entry's curated factors (each glucose entry carries its own mmol/L factor)
// are the ones applied. When a date has multiple readings (a genuine same-date
// conflict the read-layer keeps distinct), the LAST one wins (series are oldest-first,
// id-ascending, so this is the most recently stored) — a deterministic, documented
// tie-break.
function toCanonicalByDate(
  readings: ComponentReading[],
  canonical: string,
  spec: InputSpec
): Map<string, ResolvedComponent> {
  const byDate = new Map<string, ResolvedComponent>();
  for (const r of readings) {
    const v = convertToCanonical(r.value, r.unit, {
      name: canonical,
      unit: spec.unit,
    });
    if (v != null)
      byDate.set(r.date, { value: v, name: canonical, bound: r.bound });
  }
  return byDate;
}

// Whole days between two YYYY-MM-DD dates (|b - a|), or Infinity if unparseable.
function absDays(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(Math.round((tb - ta) / 86_400_000));
}

// Pick the reading in `byDate` nearest to `anchor` within `windowDays` (0 = same
// date only). Prefers an exact same-date match, then the smallest day gap, then
// the later date on ties — a stable, documented selection.
function nearestWithin(
  byDate: Map<string, ResolvedComponent>,
  anchor: string,
  windowDays: number
): ResolvedComponent | null {
  if (byDate.has(anchor)) return byDate.get(anchor)!;
  if (windowDays <= 0) return null;
  let best: { date: string; gap: number; hit: ResolvedComponent } | null = null;
  for (const [date, hit] of byDate) {
    const gap = absDays(anchor, date);
    if (gap > windowDays) continue;
    if (!best || gap < best.gap || (gap === best.gap && date > best.date))
      best = { date, gap, hit };
  }
  return best ? best.hit : null;
}

// Resolve ONE input for a draw across the names it accepts. Same-draw pairing wins
// first — every accepted name is tried on the anchor date before any of them is
// allowed to reach into the window — and within each tier the input's own preference
// order decides, so a preferred sibling never wins by being nearer in time than an
// accepted one that is actually ON the draw.
function resolveInput(
  maps: Map<string, ResolvedComponent>[],
  anchor: string,
  windowDays: number
): ResolvedComponent | null {
  for (const m of maps) {
    const exact = nearestWithin(m, anchor, 0);
    if (exact) return exact;
  }
  if (windowDays <= 0) return null;
  for (const m of maps) {
    const near = nearestWithin(m, anchor, windowDays);
    if (near) return near;
  }
  return null;
}

// Format the human formula with the actual component values substituted and the
// result appended, for the "derived" subtitle/tooltip on the UI. A censored component
// keeps its marker here too ("CRP <0.2") — the substituted limit is never printed as
// though it were an exact reading.
function formatFormula(
  def: DerivedDef,
  vals: Record<string, ResolvedComponent>,
  result: number
): string {
  const parts = def.inputs
    .map((i) => {
      const hit = vals[inputKey(i)];
      return `${i.label} ${hit.bound ?? ""}${roundTo(hit.value, 1)}`;
    })
    .join(", ");
  const shown = roundTo(result, def.decimals);
  return `${def.formulaLabel} = ${shown} (${parts})`;
}

// Which way a censored component's substituted limit pushes the result, given how
// that input moves the index: a "<" bound means the true value is BELOW the limit, so
// on an input that RAISES the index the computed number can only be too high.
function biasOf(direction: "+" | "-", bound: "<" | ">"): CensoredBias {
  const raises = direction === "+";
  return bound === "<"
    ? raises
      ? "over"
      : "under"
    : raises
      ? "under"
      : "over";
}

// The censoring summary for one computed reading, or undefined when every component
// was exact. `bias` is stated only when the index declared its input directions AND
// every censored input pushes the same way — mixed or undeclared stays null rather
// than picking a direction the index hasn't earned.
function censoringOf(
  def: DerivedDef,
  vals: Record<string, ResolvedComponent>
): CensoredSummary | undefined {
  const censored = def.inputs
    .map((i) => ({ spec: i, hit: vals[inputKey(i)] }))
    .filter((x) => x.hit.bound != null);
  if (censored.length === 0) return undefined;
  const biases = censored.map((x) => {
    const dir = def.inputDirection?.[inputKey(x.spec)];
    return dir ? biasOf(dir, x.hit.bound!) : null;
  });
  const bias =
    biases[0] != null && biases.every((b) => b === biases[0])
      ? biases[0]
      : null;
  return {
    inputs: censored.map((x) => ({
      name: x.hit.name,
      label: x.spec.label,
      bound: x.hit.bound!,
    })),
    bias,
  };
}

// Resolve the reference value one PhenoAge input is compared AGAINST. The rule lives
// with the caller because the values come from the curated canonical dataset (a DB
// read, and an age/sex-resolved band): this module states WHAT the counterfactual is,
// not where the target came from. Returning null means the dataset states no target —
// which produces an explicit "no comparison", never a zero effect.
export type PhenoAgeReferenceResolver = (input: {
  key: string;
  // The canonical name the draw's value actually came from — the entry whose bands
  // apply, so a draw carrying the band-less unqualified "Glucose" (#2337) honestly
  // reports that it has no reference.
  name: string;
  date: string;
}) => PhenoAgeReference | null;

// The leave-one-out decomposition of ONE complete PhenoAge draw, in years, ranked by
// magnitude. `vals`/`hits` are the exact canonical-unit component values that produced
// `baseline`, so every row is a genuine counterfactual on the same draw.
function phenoAgeInputEffects(
  def: DerivedDef,
  vals: Record<string, number>,
  hits: Record<string, ResolvedComponent>,
  ageYears: number,
  baseline: number,
  date: string,
  resolve: PhenoAgeReferenceResolver
): PhenoAgeInputEffect[] {
  // Years this run of the model differs from the actual result. Null when the
  // counterfactual is undefined (the model declines at that value) — an unanswerable
  // comparison is reported as absent, not as no effect.
  const effect = (counterfactual: number | null): number | null =>
    counterfactual == null ? null : roundTo(baseline - counterfactual, 1);

  const rows: PhenoAgeInputEffect[] = def.inputs.map((spec) => {
    const key = inputKey(spec);
    const hit = hits[key];
    const reference = resolve({ key, name: hit.name, date });
    return {
      key,
      name: hit.name,
      label: spec.label,
      value: roundTo(hit.value, 2),
      unit: spec.unit,
      ...(hit.bound ? { bound: hit.bound } : {}),
      reference,
      effectYears:
        reference == null
          ? null
          : effect(
              phenoAgeFromCanonical(
                { ...vals, [key]: reference.value },
                ageYears
              )
            ),
    };
  });

  // The tenth input. Its reference is the model's own floor rather than a curated
  // band: "you, at the youngest age this model is applied at", which is checkable and
  // stated, where an "optimal age" would be invented.
  rows.push({
    key: AGE_INPUT_KEY,
    name: AGE_INPUT_KEY,
    label: "Age",
    value: ageYears,
    unit: "years",
    reference: { value: PHENOAGE_MIN_AGE, basis: "model-floor" },
    effectYears: effect(phenoAgeFromCanonical(vals, PHENOAGE_MIN_AGE)),
  });

  // Ranked by absolute effect, largest first — the ordering IS the insight, and it is
  // stable and explainable. Rows with no comparison sort last (they are not "zero"),
  // keeping spec order among themselves.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ea = a.row.effectYears;
      const eb = b.row.effectYears;
      if (ea == null || eb == null) {
        if (ea == null && eb == null) return a.i - b.i;
        return ea == null ? 1 : -1;
      }
      const d = Math.abs(eb) - Math.abs(ea);
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.row);
}

export interface ComputeOptions {
  // Loosen same-draw pairing to inputs within this many days of the anchor draw.
  // Default 0 (strict same-date) — the safe default; a larger window is a caller's
  // explicit choice.
  windowDays?: number;
  // Draw dates for which a STORED reading of the derived analyte already exists,
  // per derived name — those dates are skipped so a lab that reports e.g. Non-HDL
  // or eGFR directly is never shadowed by a computed duplicate.
  storedDatesByName?: Partial<Record<DerivedName, Set<string>>>;
  // Supply this to attach the PhenoAge leave-one-out decomposition (#2366) to each
  // complete PhenoAge reading. Omitted (the sidecar/notification callers, every
  // non-bio-age surface) → no `effects`, and no extra model runs.
  phenoAgeReference?: PhenoAgeReferenceResolver;
}

// Compute every derivable index from the component series. `seriesByCanonical`
// maps each input canonical name to its exact numeric readings (oldest-first).
// Returns all derived readings, sorted by (name order, date ascending). Pure.
export function computeDerivedReadings(
  seriesByCanonical: Map<string, ComponentReading[]>,
  demo: DerivedDemographics,
  opts: ComputeOptions = {}
): DerivedReading[] {
  const windowDays = opts.windowDays ?? 0;
  const out: DerivedReading[] = [];

  for (const def of DERIVED_DEFS) {
    // Convert each input's accepted series to date -> canonical value up front, in
    // the input's own preference order.
    const inputMaps = def.inputs.map((spec) =>
      inputAccepts(spec).map((canonical) =>
        toCanonicalByDate(
          seriesByCanonical.get(canonical) ?? [],
          canonical,
          spec
        )
      )
    );
    // Anchor on the first input's draw dates (all components share a draw date in
    // the same-draw case) — across every name that input accepts, so a draw is never
    // missed for having recorded the analyte under the sibling spelling. Sorted for
    // deterministic output.
    const anchorDates = [
      ...new Set(inputMaps[0].flatMap((m) => [...m.keys()])),
    ].sort();
    const stored = opts.storedDatesByName?.[def.name];

    for (const date of anchorDates) {
      if (stored?.has(date)) continue; // a real stored reading wins this draw
      const hits: Record<string, ResolvedComponent> = {};
      const vals: Record<string, number> = {};
      let complete = true;
      for (let i = 0; i < def.inputs.length; i++) {
        const hit = resolveInput(inputMaps[i], date, windowDays);
        if (hit == null) {
          complete = false;
          break;
        }
        hits[inputKey(def.inputs[i])] = hit;
        vals[inputKey(def.inputs[i])] = hit.value;
      }
      if (!complete) continue;

      const raw = def.compute(vals, demo, date);
      if (raw == null || !Number.isFinite(raw)) continue;

      const value = roundTo(raw, def.decimals);
      const censored = censoringOf(def, hits);
      // The decomposition rides along with the number it decomposes: same pass, same
      // exact component values, same evaluation function (#2366). PhenoAge is the one
      // index that has one — it is the only linear-predictor model here, and the only
      // index whose output unit (years) makes a counterfactual readable as itself.
      const age = def.name === "PhenoAge" ? demo.ageOn(date) : null;
      const effects =
        opts.phenoAgeReference && age != null
          ? phenoAgeInputEffects(
              def,
              vals,
              hits,
              age,
              raw,
              date,
              opts.phenoAgeReference
            )
          : undefined;
      out.push({
        name: def.name,
        date,
        value,
        unit: def.unit,
        formula: formatFormula(def, hits, raw),
        inputs: def.inputs.map((i) => {
          const hit = hits[inputKey(i)];
          return {
            // The name the value ACTUALLY came from, so a surface links to the series
            // it was read out of rather than the input's preferred spelling.
            name: hit.name,
            value: roundTo(hit.value, 2),
            unit: i.unit,
            ...(hit.bound ? { bound: hit.bound } : {}),
          };
        }),
        ...(censored ? { censored } : {}),
        ...(effects ? { effects } : {}),
      });
    }
  }

  return out;
}
