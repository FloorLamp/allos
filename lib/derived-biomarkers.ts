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

// The canonical output names — each MUST exist as a canonical_biomarkers row so
// the shared reference/optimal-range + flag machinery treats a derived value like
// any other analyte (ranges, badges, digest classification).
export const DERIVED_NAMES = [
  "Non-HDL Cholesterol",
  "Triglyceride/HDL Ratio",
  "HOMA-IR",
  "eGFR",
  "PhenoAge",
] as const;
export type DerivedName = (typeof DERIVED_NAMES)[number];

// A raw component reading as it comes off the stored series: a numeric value in
// some (possibly missing) unit, on a date. `value` is the exact numeric reading
// (medical_records.value_num) — bounded/qualitative readings are not usable inputs
// to an arithmetic index, so callers pass only exact numbers.
export interface ComponentReading {
  date: string; // YYYY-MM-DD
  value: number;
  unit: string | null;
}

// Demographics needed by demographic-dependent indices (eGFR). `ageOn` resolves
// the subject's whole-year age on a given draw date (birthdate-derived, else the
// stored age) or null when unknown; `sex` is the profile's sex or null. Both null
// paths make eGFR decline to compute rather than guess.
export interface DerivedDemographics {
  sex: Sex | null;
  ageOn: (date: string) => number | null;
}

// One computed derived reading. `value` is already rounded to the index's display
// precision; `unit` is the canonical output unit; `formula` is a human-readable
// expression with the actual component values substituted, for the "derived"
// subtitle/tooltip; `inputs` lists the canonical-unit component values used.
export interface DerivedReading {
  name: DerivedName;
  date: string;
  value: number;
  unit: string;
  formula: string;
  inputs: { name: string; value: number; unit: string }[];
}

interface InputSpec {
  // Canonical analyte name (must match a canonical_biomarkers row) — also the key
  // the query layer reads a stored series for.
  canonical: string;
  // The canonical unit the formula expects the value in; readings in other units
  // are converted to this via lib/unit-conversions before the formula runs.
  unit: string;
  // Short token used in the human formula string (e.g. "Total", "HDL").
  label: string;
}

interface DerivedDef {
  name: DerivedName;
  unit: string; // canonical output unit
  decimals: number; // display precision for the computed value
  inputs: InputSpec[];
  // A generic caption of the formula (no values), e.g. "Total − HDL".
  formulaLabel: string;
  needsSex?: boolean;
  needsAge?: boolean;
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

// PhenoAge is developed/validated in ADULTS (NHANES III/IV, ages ~20–84); it is
// not meaningful for children, so — mirroring how age-dependent surfaces gate off
// child profiles (see lib/age-gate.ts) — the deriver emits NOTHING below this age.
// Exported so the biological-age surfaces (lib/bio-age.ts) gate their hero card on
// exactly the same adult floor the computation uses.
export const PHENOAGE_MIN_AGE = 18;

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
    name: "HOMA-IR",
    unit: "index",
    decimals: 2,
    formulaLabel: "(Fasting glucose mg/dL × fasting insulin µU/mL) ÷ 405",
    inputs: [
      { canonical: "Glucose", unit: "mg/dL", label: "Glucose" },
      { canonical: "Insulin", unit: "uIU/mL", label: "Insulin" },
    ],
    compute: (v) => {
      const homa = (v["Glucose"] * v["Insulin"]) / 405;
      return Number.isFinite(homa) ? homa : null;
    },
  },
  {
    name: "eGFR",
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
      if ((sex !== "male" && sex !== "female") || age == null) return null;
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
    // All nine analytes required from ONE draw (no imputation). Units here are the
    // app's CANONICAL units; compute() converts each to the formula unit.
    inputs: [
      { canonical: "Albumin", unit: "g/dL", label: "Alb" },
      { canonical: "Creatinine", unit: "mg/dL", label: "Cr" },
      { canonical: "Glucose", unit: "mg/dL", label: "Glu" },
      { canonical: "hs-CRP", unit: "mg/L", label: "CRP" },
      { canonical: "Lymphocytes", unit: "%", label: "Lym%" },
      { canonical: "MCV", unit: "fL", label: "MCV" },
      { canonical: "RDW", unit: "%", label: "RDW" },
      { canonical: "Alkaline Phosphatase", unit: "U/L", label: "ALP" },
      { canonical: "White Blood Cell Count", unit: "10^3/uL", label: "WBC" },
    ],
    compute: (v, demo, date) => {
      const age = demo.ageOn(date);
      // Never guess: PhenoAge needs a known chronological age, and is adult-only.
      if (age == null || age < PHENOAGE_MIN_AGE) return null;
      return phenoAge({
        albuminGL: v["Albumin"] * ALBUMIN_GDL_TO_GL,
        creatinineUmolL: v["Creatinine"] * CREATININE_MGDL_TO_UMOLL,
        glucoseMmolL: v["Glucose"] * GLUCOSE_MGDL_TO_MMOLL,
        crpMgDl: v["hs-CRP"] * CRP_MGL_TO_MGDL,
        lymphocytePct: v["Lymphocytes"],
        mcvFl: v["MCV"],
        rdwPct: v["RDW"],
        alpUL: v["Alkaline Phosphatase"],
        wbcThousandUl: v["White Blood Cell Count"],
        ageYears: age,
      });
    },
  },
];

export const DERIVED_DEFS_BY_NAME: Record<DerivedName, DerivedDef> =
  Object.fromEntries(DERIVED_DEFS.map((d) => [d.name, d])) as Record<
    DerivedName,
    DerivedDef
  >;

// The canonical input analytes any derived index depends on — the set of series
// the query layer must load to compute all indices.
export function derivedInputCanonicalNames(): string[] {
  const s = new Set<string>();
  for (const d of DERIVED_DEFS) for (const i of d.inputs) s.add(i.canonical);
  return [...s];
}

// The canonical input analytes ONE derived index depends on, or [] when `name`
// isn't a derived index. The retest clock (#482 scope 2) uses this: a derived
// value's retest is satisfied when its INPUTS are fresh — a stored Non-HDL is not
// "overdue" while a recent Total + HDL exist — because re-drawing the inputs
// re-derives it. The input→derived relation is a family the clock honors.
export function derivedInputCanonicalNamesFor(name: string): string[] {
  const def = DERIVED_DEFS_BY_NAME[name as DerivedName];
  return def ? def.inputs.map((i) => i.canonical) : [];
}

// Reduce a component series to date -> canonical value, converting each reading to
// the input's canonical unit and dropping readings that can't be converted. When a
// date has multiple readings (a genuine same-date conflict the read-layer keeps
// distinct), the LAST one wins (series are oldest-first, id-ascending, so this is
// the most recently stored) — a deterministic, documented tie-break.
function toCanonicalByDate(
  readings: ComponentReading[],
  spec: InputSpec
): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const r of readings) {
    const v = convertToCanonical(r.value, r.unit, {
      name: spec.canonical,
      unit: spec.unit,
    });
    if (v != null) byDate.set(r.date, v);
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
  byDate: Map<string, number>,
  anchor: string,
  windowDays: number
): number | null {
  if (byDate.has(anchor)) return byDate.get(anchor)!;
  if (windowDays <= 0) return null;
  let best: { date: string; gap: number; value: number } | null = null;
  for (const [date, value] of byDate) {
    const gap = absDays(anchor, date);
    if (gap > windowDays) continue;
    if (!best || gap < best.gap || (gap === best.gap && date > best.date))
      best = { date, gap, value };
  }
  return best ? best.value : null;
}

// Format the human formula with the actual component values substituted and the
// result appended, for the "derived" subtitle/tooltip on the UI.
function formatFormula(
  def: DerivedDef,
  vals: Record<string, number>,
  result: number
): string {
  const parts = def.inputs
    .map((i) => `${i.label} ${roundTo(vals[i.canonical], 1)}`)
    .join(", ");
  const shown = roundTo(result, def.decimals);
  return `${def.formulaLabel} = ${shown} (${parts})`;
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
    // Convert each input series to date -> canonical value up front.
    const inputMaps = def.inputs.map((spec) =>
      toCanonicalByDate(seriesByCanonical.get(spec.canonical) ?? [], spec)
    );
    // Anchor on the first input's draw dates (all components share a draw date in
    // the same-draw case). Sorted for deterministic output.
    const anchorDates = [...inputMaps[0].keys()].sort();
    const stored = opts.storedDatesByName?.[def.name];

    for (const date of anchorDates) {
      if (stored?.has(date)) continue; // a real stored reading wins this draw
      const vals: Record<string, number> = {};
      let complete = true;
      for (let i = 0; i < def.inputs.length; i++) {
        const v = nearestWithin(inputMaps[i], date, windowDays);
        if (v == null) {
          complete = false;
          break;
        }
        vals[def.inputs[i].canonical] = v;
      }
      if (!complete) continue;

      const raw = def.compute(vals, demo, date);
      if (raw == null || !Number.isFinite(raw)) continue;

      const value = roundTo(raw, def.decimals);
      out.push({
        name: def.name,
        date,
        value,
        unit: def.unit,
        formula: formatFormula(def, vals, raw),
        inputs: def.inputs.map((i) => ({
          name: i.canonical,
          value: roundTo(vals[i.canonical], 2),
          unit: i.unit,
        })),
      });
    }
  }

  return out;
}
