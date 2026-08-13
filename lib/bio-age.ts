// Biological-age (PhenoAge) headline helpers (issue #209). PURE, no DB/network.
//
// The derived-biomarker framework (issue #157, lib/derived-biomarkers.ts) already
// computes Levine's PhenoAge — a "biological age" in years — as one virtual analyte
// row. This module turns that raw number into the things the hero card needs but the
// row can't say: the delta to CHRONOLOGICAL age (younger = good), the pace-of-aging
// (does the gap widen over time — via the same robust slope the trajectory engine
// uses), and input-completeness (how many of the nine analytes are present, and which
// are missing — the partial-panel import CTA).
//
// Everything here is a pure function of already-resolved values; the DB seam
// (lib/queries/derived.ts → getBioAgeReadings) feeds it the computed draws and the
// present-input set, and the card/widget are thin formatters over these results — the
// "one question, one computation" rule (see AGENTS.md).
//
// FRAMING: PhenoAge is an ESTIMATE from a population mortality model (Levine 2018),
// validated in NHANES adults (~20–84), that moves with its nine inputs — never a
// precise verdict. The card carries that caveat; these helpers stay numeric.

import { theilSenSlopePerDay, type DatedPoint } from "./robust-stats";
import {
  derivedInputCanonicalNamesFor,
  derivedInputKeysFor,
  AGE_INPUT_KEY,
  type CensoredSummary,
  type PhenoAgeInputEffect,
  type PhenoAgeReference,
} from "./derived-biomarkers";
import { isAdultForClinical } from "./life-stage";
import { optimalBand, referenceRange } from "./reference-range/selection";
import type {
  CanonicalResultDefinition,
  ReproductiveStatus,
  Sex,
} from "./types";

// Julian year — matches the day→year conversion in lib/biomarker-trajectory.
const DAYS_PER_YEAR = 365.25;

// The nine PhenoAge input analytes, by canonical name, sourced from the single
// derived-biomarker definition so this list can never drift from what the formula
// actually consumes. Order follows the definition (stable for the checklist). One
// entry per INPUT — an input that accepts sibling spellings (glucose, #2334) is one
// checklist line under its preferred name, not two things to go and get.
export const PHENOAGE_INPUT_NAMES: string[] = derivedInputKeysFor("PhenoAge");

// Every canonical spelling any PhenoAge input accepts — the checklist names plus the
// siblings a slot will take. For surfaces asking "is this stored analyte a PhenoAge
// input?" of an arbitrary name, where the answer must be yes for either spelling.
export const PHENOAGE_INPUT_ACCEPTED_NAMES: string[] =
  derivedInputCanonicalNamesFor("PhenoAge");

// Nine — the count of analytes a complete PhenoAge draw needs.
export const PHENOAGE_INPUT_COUNT = PHENOAGE_INPUT_NAMES.length;

// Round to one decimal, guarding -0.
function round1(n: number): number {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

// ── Bio-age delta to chronological age ────────────────────────────────────────

export type BioAgeDirection = "younger" | "older" | "even";

export interface BioAgeDelta {
  // The estimated biological age (years, 1 dp).
  bioAge: number;
  // Chronological age on the draw date (whole years as stored/derived).
  chronoAge: number;
  // Signed years: bioAge − chronoAge (negative = biologically younger).
  deltaYears: number;
  // |deltaYears|, rounded to 1 dp — the magnitude the card shows.
  magnitudeYears: number;
  // younger (delta < 0), older (delta > 0), or even (rounds to 0.0).
  direction: BioAgeDirection;
}

// The delta of a single complete draw. Younger-than-calendar is the good direction.
export function bioAgeDelta(bioAge: number, chronoAge: number): BioAgeDelta {
  const deltaYears = bioAge - chronoAge;
  const magnitudeYears = Math.abs(round1(deltaYears));
  const direction: BioAgeDirection =
    magnitudeYears === 0 ? "even" : deltaYears < 0 ? "younger" : "older";
  return {
    bioAge: round1(bioAge),
    chronoAge,
    deltaYears: round1(deltaYears),
    magnitudeYears,
    direction,
  };
}

// A human phrase for the delta ("3.2 years younger than your calendar age of 50").
export function bioAgeDeltaPhrase(d: BioAgeDelta): string {
  if (d.direction === "even") {
    return `about the same as your calendar age of ${d.chronoAge}`;
  }
  const unit = d.magnitudeYears === 1 ? "year" : "years";
  return `${d.magnitudeYears} ${unit} ${d.direction} than your calendar age of ${d.chronoAge}`;
}

// ── Pace of aging (the delta trend over time) ─────────────────────────────────

// A complete PhenoAge draw reduced to what the pace math needs.
export interface BioAgeDrawPoint {
  date: string; // YYYY-MM-DD
  bioAge: number;
  chronoAge: number;
}

// "none": no complete draw. "single": exactly one usable draw (or several that
// share a day, so no time axis) — show the value with a "one measurement" note and
// NO slope. "trend": ≥2 complete draws spanning ≥1 day, so a slope exists.
export type PaceStatus = "none" | "single" | "trend";

// Widening = the gap to calendar age is growing (aging faster than the calendar);
// narrowing = the gap is shrinking (aging slower); stable = holding within a hair.
export type PaceTrend = "widening" | "narrowing" | "stable";

export interface PaceOfAging {
  status: PaceStatus;
  // Number of complete draws considered.
  draws: number;
  // Change in the delta (bioAge − chronoAge) per YEAR: >0 widening, <0 narrowing.
  // null unless status === "trend".
  slopePerYear: number | null;
  trend: PaceTrend | null;
}

// A |slope| at or below this (years of delta per year) reads as holding steady.
export const PACE_STABLE_EPS = 0.1;

// Pace-of-aging from the complete-draw series. Uses the robust Theil–Sen slope of
// the DELTA series (bioAge − chronoAge over time) — the same estimator the biomarker
// trajectory engine uses — so a single noisy draw can't invent a pace. No slope is
// produced below two draws or when every draw shares a calendar day (the required
// ≥2-complete-draws rule for a trend line).
export function paceOfAging(draws: readonly BioAgeDrawPoint[]): PaceOfAging {
  const n = draws.length;
  if (n === 0)
    return { status: "none", draws: 0, slopePerYear: null, trend: null };
  if (n === 1)
    return { status: "single", draws: 1, slopePerYear: null, trend: null };

  const points: DatedPoint[] = draws.map((d) => ({
    date: d.date,
    value: d.bioAge - d.chronoAge,
  }));
  const perDay = theilSenSlopePerDay(points);
  // ≥2 draws but no pair spans time (all same day) → degenerate to "single": a
  // trend line needs a real time axis.
  if (perDay == null)
    return { status: "single", draws: n, slopePerYear: null, trend: null };

  const slopePerYear = round1(perDay * DAYS_PER_YEAR);
  const trend: PaceTrend =
    Math.abs(slopePerYear) <= PACE_STABLE_EPS
      ? "stable"
      : slopePerYear > 0
        ? "widening"
        : "narrowing";
  return { status: "trend", draws: n, slopePerYear, trend };
}

// A human phrase for the pace, or null when there's no trend to describe.
export function paceOfAgingPhrase(p: PaceOfAging): string | null {
  if (p.status !== "trend" || p.slopePerYear == null) return null;
  if (p.trend === "stable") {
    return "Your gap to calendar age is holding steady across draws.";
  }
  const rate = Math.abs(p.slopePerYear);
  const unit = rate === 1 ? "year" : "years";
  return p.trend === "widening"
    ? `The gap is widening about ${rate} ${unit} per year — aging faster than the calendar.`
    : `The gap is narrowing about ${rate} ${unit} per year — aging slower than the calendar.`;
}

// ── Input completeness (n of 9) ───────────────────────────────────────────────

export interface InputCompleteness {
  // Present / missing canonical analyte names, in PHENOAGE_INPUT_NAMES order.
  present: string[];
  missing: string[];
  presentCount: number;
  totalCount: number;
  // True only when all nine inputs are present.
  complete: boolean;
}

// Which of the nine PhenoAge inputs a profile has (any usable reading of), and which
// it still needs. `available` is the set/list of canonical analyte names the profile
// has readings for; unrelated names are ignored.
export function inputCompleteness(
  available: Iterable<string>
): InputCompleteness {
  const have = new Set<string>();
  for (const name of available) have.add(name);
  const present = PHENOAGE_INPUT_NAMES.filter((n) => have.has(n));
  const missing = PHENOAGE_INPUT_NAMES.filter((n) => !have.has(n));
  return {
    present,
    missing,
    presentCount: present.length,
    totalCount: PHENOAGE_INPUT_COUNT,
    complete: missing.length === 0,
  };
}

// Join names into an Oxford-comma list ("A", "A and B", "A, B, and C").
function humanizeList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// The partial-panel checklist message ("7 of 9 inputs present; add hs-CRP and Albumin
// to compute your biological age"), or an all-present confirmation when complete.
export function completenessChecklistMessage(c: InputCompleteness): string {
  if (c.complete) {
    return `All ${c.totalCount} inputs present.`;
  }
  return `${c.presentCount} of ${c.totalCount} inputs present; add ${humanizeList(
    c.missing
  )} to compute your biological age.`;
}

// ── Censored inputs (#2334) ───────────────────────────────────────────────────
//
// A lab reports an undetectable analyte as "<0.2", not as a number. The app's
// convention for such a value is substitute the limit, KEEP the marker, show it — a
// chart can say it with a hollow dot and a "<" in the tooltip. A single "biological
// age" number has no such channel, so the marker has to be said in words, or the
// estimate presents as exact when one of its nine inputs was not measured exactly.

// The parts of a complete draw this note reads.
export interface BioAgeDrawInputs {
  inputs: { name: string; value: number; unit: string; bound?: "<" | ">" }[];
  censored?: CensoredSummary;
}

// The sentence a bio-age surface shows when its number rests on a component that was
// reported beyond a detection limit: WHICH input, at WHAT limit, and — only when the
// index has declared how that input moves it — which way the substitution biases the
// result. Null when every component was an exact number.
export function censoredInputNote(draw: BioAgeDrawInputs): string | null {
  const censored = draw.censored;
  if (!censored || censored.inputs.length === 0) return null;
  const named = censored.inputs.map((c) => {
    const input = draw.inputs.find((i) => i.name === c.name);
    const at =
      input == null
        ? ""
        : ` at ${input.value}${input.unit ? ` ${input.unit}` : ""}`;
    const side = c.bound === "<" ? "below" : "above";
    return `${c.name} was reported ${side} its detection limit and substituted${at}`;
  });
  const lead = `Rests on ${
    named.length > 1 ? "censored inputs" : "a censored input"
  }: ${humanizeList(named)}.`;
  // The bias is worth stating BECAUSE it is knowable: substituting the limit of a
  // below-detection hs-CRP assumes the worst case for a term that raises the age, so
  // the estimate can only be too high from it. An index that hasn't declared its
  // input directions says nothing here rather than implying the error is symmetric.
  const bias =
    censored.bias === "over"
      ? " The estimate can only be too high from that substitution."
      : censored.bias === "under"
        ? " The estimate can only be too low from that substitution."
        : "";
  return `${lead}${bias}`;
}

// ── What moves the number (#2366) ─────────────────────────────────────────────
//
// The counterfactual itself is arithmetic on the model and lives with the model
// (lib/derived-biomarkers → PhenoAgeInputEffect, computed in the same pass that
// produced the reading). What lives HERE is the two things the surface needs and the
// model has no business knowing: WHICH value each input is compared against, and how
// to say the result in words that cannot be read as advice.

// The reference value for one PhenoAge input, read off the curated canonical entry:
// the OPTIMAL band's midpoint where one exists, else the reference band's midpoint —
// so the counterfactual is "you, at the value this analyte is curated toward", the
// comparison a reader is implicitly making anyway. A one-sided band (hs-CRP's
// "optimal ≤1 mg/L", which has no lower edge) has no midpoint, so the stated bound
// itself IS the target. An entry with NEITHER band — the unqualified `Glucose`, which
// is deliberately band-less because a draw that never said whether the patient fasted
// cannot be judged (#2337) — returns null, and the surface says it has no comparison
// rather than inventing a target.
//
// The band is resolved through the app's own age/sex/status selectors, so an input
// whose curated band is demographic-specific is compared against the band that
// actually applies to this profile.
export function phenoAgeReferenceValue(
  cb: CanonicalResultDefinition | null | undefined,
  sex: Sex | null,
  age: number | null,
  status: ReproductiveStatus | null
): PhenoAgeReference | null {
  if (!cb) return null;
  const optimal = optimalBand(cb, sex, age);
  const ref = referenceRange(cb, sex, age, status);
  const low = optimal.low ?? ref.low;
  const high = optimal.high ?? ref.high;
  const basis: PhenoAgeReference["basis"] =
    optimal.low != null || optimal.high != null ? "optimal" : "reference";
  if (low != null && high != null) return { value: (low + high) / 2, basis };
  const single = low ?? high;
  return single != null ? { value: single, basis } : null;
}

// How a reference value is described in one word, for the "vs 4.7 g/dL (optimal)"
// caption. The basis is always shown: a target the reader can check beats a number
// they have to trust.
export function phenoAgeReferenceBasisLabel(r: PhenoAgeReference): string {
  return r.basis === "model-floor"
    ? "youngest modelled age"
    : r.basis === "optimal"
      ? "optimal"
      : "reference";
}

// The row's effect as a signed year figure ("+1.4 yr" / "−0.6 yr"), or null when
// there is no comparison to state. A minus sign, not a hyphen.
export function bioAgeEffectLabel(e: PhenoAgeInputEffect): string | null {
  if (e.effectYears == null) return null;
  const v = round1(e.effectYears);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "±";
  return `${sign}${Math.abs(v).toFixed(1)} yr`;
}

// The sentence under one row, phrased as a statement about the MODEL. PhenoAge is a
// population mortality regression: "your CRP is costing you 1.4 years" is a claim
// about the person that the model cannot support, while "the model reads 1.4 years
// higher than it would with this input at 0.5 mg/L" is exactly what was computed. The
// copy stays on the second side of that line — descriptive, never an instruction, and
// never a prediction that changing the input would change anything (see the attention
// doctrine in docs/internals/findings.md).
export function bioAgeEffectPhrase(e: PhenoAgeInputEffect): string {
  if (e.reference == null || e.effectYears == null) {
    return `No curated reference value for ${e.name}, so this input has no comparison — not a zero effect.`;
  }
  const at = `${round1(e.reference.value)}${e.unit ? ` ${e.unit}` : ""} (${phenoAgeReferenceBasisLabel(e.reference)})`;
  const years = Math.abs(round1(e.effectYears));
  const unit = years === 1 ? "year" : "years";
  if (years === 0) return `Reads the same with this input at ${at}.`;
  const direction = e.effectYears > 0 ? "higher" : "lower";
  const bounded = e.bound
    ? " That input was reported beyond a detection limit, so this comparison rests on the substituted limit."
    : "";
  return `The model reads ${years} ${unit} ${direction} than it would with this input at ${at}.${bounded}`;
}

// Is the chronological-age row? The tenth input is not an analyte, so a surface links
// the other nine to their series and this one to nothing.
export function isBioAgeAgeInput(e: PhenoAgeInputEffect): boolean {
  return e.key === AGE_INPUT_KEY;
}

// ── Adult gate ────────────────────────────────────────────────────────────────

// Hidden for CHILD profiles — the card gates on exactly the adult floor the
// computation uses (PhenoAge is an adult population model). An UNKNOWN age is never
// hidden: we hide on a positive under-age match, not on missing data (an unknown-age
// adult can still see the import checklist). This is the inverse of the shared
// adult-clinical predicate (lib/life-stage) — `isAdultForClinical` is false for both
// a child AND an unknown age, so the "hidden" answer must additionally require a
// KNOWN age to preserve the show-on-unknown policy.
export function isBioAgeHiddenForAge(age: number | null): boolean {
  return age != null && !isAdultForClinical(age);
}

// ── Surface state ─────────────────────────────────────────────────────────────

// Which bio-age surface renders: the headline HERO (≥1 complete draw), the
// missing-inputs CHECKLIST CTA (no complete draw but at least one of the nine
// inputs present — a labs-empty profile gets nothing, the page's own empty state
// covers it), or HIDDEN (age-gated, or nothing to show).
//
// ONE decision shared by both bio-age surfaces, which since #2367 render DIFFERENT
// parts of it on different pages: the Longevity §1 hero
// (app/(app)/longevity/BioAgeSection.tsx) renders the "hero" state only — the number
// is a longevity index and belongs on exactly one page — while the Biomarkers-page
// input panel (app/(app)/results/BioAgeInputsCard.tsx) renders on BOTH non-hidden
// states, because "which analytes does this still need" is a question about the
// catalog and the answer is useful whether or not the panel is complete. The states
// come from here rather than from either page, so the two can never disagree about
// whether bio-age renders at all. `hiddenForProfile` is the caller's combined gate
// (isBioAgeHiddenForAge + any surface-level restriction like the training age gate).
export type BioAgeSurface = "hidden" | "checklist" | "hero";

export function bioAgeSurface(
  hiddenForProfile: boolean,
  completeDrawCount: number,
  presentInputCount: number
): BioAgeSurface {
  if (hiddenForProfile) return "hidden";
  if (completeDrawCount > 0) return "hero";
  return presentInputCount > 0 ? "checklist" : "hidden";
}
