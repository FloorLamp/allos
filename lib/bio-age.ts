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
import { DERIVED_DEFS_BY_NAME, PHENOAGE_MIN_AGE } from "./derived-biomarkers";

// Julian year — matches the day→year conversion in lib/biomarker-trajectory.
const DAYS_PER_YEAR = 365.25;

// The nine PhenoAge input analytes, by canonical name, sourced from the single
// derived-biomarker definition so this list can never drift from what the formula
// actually consumes. Order follows the definition (stable for the checklist).
export const PHENOAGE_INPUT_NAMES: string[] = DERIVED_DEFS_BY_NAME[
  "PhenoAge"
].inputs.map((i) => i.canonical);

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

// ── Adult gate ────────────────────────────────────────────────────────────────

// Hidden for CHILD profiles — the card gates on exactly the adult floor the
// computation uses (PhenoAge is an adult population model). Mirroring lib/age-gate.ts,
// an UNKNOWN age is never hidden: we hide on a positive under-age match, not on
// missing data (an unknown-age adult can still see the import checklist).
export function isBioAgeHiddenForAge(age: number | null): boolean {
  return age != null && age < PHENOAGE_MIN_AGE;
}
