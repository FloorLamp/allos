// Protein-adequacy — the ONE pure computation behind the /nutrition adequacy card and
// the coaching-tier adequacy finding (issue #767). No DB, no clock, no network: the DB
// gather (lib/queries/nutrition.ts → getProteinAdequacy) assembles the typed inputs and
// hands them here, so the card and the finding are formatters over the SAME result and
// can never disagree ("one question, one computation").
//
// Intake composition (proteinIntake), superseding #767's tracked > logged > estimated
// source-priority chain (issue #824):
//   - `tracked`   — an integration's protein_g (Health Connect protein_grams → protein_g;
//                   surfaced on Trends → Nutrition → Macros & fiber, #1166). A measured
//                   FULL-DAY total, so it OVERRIDES the sum below.
//   - `estimated` — servings × per-serving grams from the food-group catalog (#579 rollup,
//                   reused, never a second engine). A FLOOR by construction — incidental
//                   protein from untracked foods is invisible.
//   - `logged`    — direct protein grams from the Food-tab quick-add (#824,
//                   lib/protein-log-write.ts) — protein powder's only home, since the
//                   whole-foods catalog has no shake group.
// When there's no tracked reading, `estimated` and `logged` SUM — a manual grams entry is
// a PARTIAL ADDITION, never an eraser of the food-group estimate (a common shape: log a
// shake's 30 g AND tap the eggs/dairy you also ate). The sum is still a FLOOR (untracked
// foods remain invisible), so every surface's copy says so ("a floor — actual likely
// higher"). The `basis` names the composition: `combined` (both parts), `logged` (grams
// only), or `estimated` (food groups only).
//
// Goal-scaled target (proteinTarget): a bodyweight-scaled g/kg band by training goal.
// Lean body mass is PREFERRED when available (lean_mass_kg) because g/kg-total overshoots
// for higher-body-fat individuals — the same ISSN band applied to the smaller lean mass
// yields a smaller, more accurate absolute target for them (a monotonic, conservative
// correction; a lean person's LBM ≈ total, so it barely moves). Band + evidence + the
// "informational, not prescriptive" framing follow the RDA-adequacy precedent (#578, lib/dri).

import { foodGroupBySlug } from "./food-groups";

// ---- Intake: tracked OVERRIDES (estimated + logged) ------------------------

// The composition of the per-day intake figure:
//   tracked   — a measured full-day total (overrides the sum).
//   combined  — the estimated food-group floor PLUS manually-logged grams.
//   logged    — manually-logged grams only (no protein-bearing food groups logged).
//   estimated — the food-group floor only (no manual grams).
export type ProteinBasis = "tracked" | "combined" | "logged" | "estimated";

export interface ProteinIntake {
  // Per-day grams. For every non-`tracked` basis this is a FLOOR (see module header).
  grams: number;
  basis: ProteinBasis;
  // The two floor components that add to `grams` for a non-`tracked` basis, so a
  // surface can name the composition honestly ("90 g estimated + 30 g logged"). Both
  // are 0 for a `tracked` basis (the measured total overrides the sum).
  estimatedGrams: number;
  loggedGrams: number;
}

// A group's summed servings, as the #579 rollup produces (GroupServingTotal is a superset).
export interface ProteinServing {
  slug: string;
  servings: number;
}

// Sum protein grams over a set of food-group servings: servings × the catalog's per-
// serving protein_g, skipping groups the catalog marks as non-protein-bearing (fruit,
// water, sweets, alcohol) and any retired/unknown slug. A FLOOR — untracked foods are
// invisible. Pure over the shared rollup so the estimate and the servings card agree.
export function estimatedProteinGrams(servings: ProteinServing[]): number {
  let grams = 0;
  for (const s of servings) {
    if (!(s.servings > 0)) continue;
    const g = foodGroupBySlug(s.slug)?.protein_g;
    if (g != null) grams += s.servings * g;
  }
  return grams;
}

// Compose the intake (issue #824): a measured `tracked` reading OVERRIDES; otherwise the
// estimated food-group floor and the manually-logged grams SUM (a manual entry is a
// partial addition, never an eraser of the estimate). Each input is an already-per-day
// figure the gather computed (an average over the days that carry it). Returns null when
// no basis has any signal (no tracked reading and neither floor component present).
export function proteinIntake(args: {
  dailyTracked: number | null;
  // Direct protein grams from the Food-tab quick-add (#824); null/omitted when the
  // profile has never logged any.
  dailyLogged?: number | null;
  dailyEstimated: number;
}): ProteinIntake | null {
  if (args.dailyTracked != null && args.dailyTracked > 0)
    return {
      grams: args.dailyTracked,
      basis: "tracked",
      estimatedGrams: 0,
      loggedGrams: 0,
    };
  const estimated = args.dailyEstimated > 0 ? args.dailyEstimated : 0;
  const logged =
    args.dailyLogged != null && args.dailyLogged > 0 ? args.dailyLogged : 0;
  const grams = estimated + logged;
  if (grams <= 0) return null;
  const basis: ProteinBasis =
    estimated > 0 && logged > 0
      ? "combined"
      : logged > 0
        ? "logged"
        : "estimated";
  return { grams, basis, estimatedGrams: estimated, loggedGrams: logged };
}

// ---- Target: goal + bodyweight (LBM-preferred) → g/kg band -----------------

export type ProteinGoalLevel = "rda" | "active" | "hypertrophy" | "cut";

// The g/kg bands per goal (issue #767 table). Applied to lean mass when available, else
// total bodyweight (see module header). Sedentary RDA is a floor; the active/hypertrophy/
// cut ranges are the ISSN position-stand figures (Jäger et al. 2017; Morton et al. 2018).
const GOAL_BANDS: Record<
  ProteinGoalLevel,
  { low: number; high: number; label: string }
> = {
  rda: { low: 0.8, high: 1.0, label: "general health (RDA)" },
  active: { low: 1.2, high: 1.6, label: "general fitness" },
  hypertrophy: { low: 1.6, high: 2.2, label: "muscle gain" },
  cut: { low: 2.0, high: 2.4, label: "cut / muscle preservation" },
};

// The default goal level when the profile hasn't set a training goal. Goal onboarding
// (#719) isn't built yet; "active" is the sensible middle for someone tracking training.
export const DEFAULT_PROTEIN_GOAL_LEVEL: ProteinGoalLevel = "active";

// Map an (optional) stored goal string to a level, defaulting to active. Forward-compat
// hook for #719 goal onboarding: the gather reads whatever setting lands and passes it
// here, so wiring a real goal later is a one-line change with no engine edit.
export function resolveProteinGoalLevel(
  goal: string | null | undefined
): ProteinGoalLevel {
  switch ((goal ?? "").toLowerCase()) {
    case "rda":
    case "general":
    case "sedentary":
      return "rda";
    case "active":
    case "fitness":
      return "active";
    case "hypertrophy":
    case "muscle":
    case "muscle_gain":
    case "bodybuilding":
      return "hypertrophy";
    case "cut":
    case "deficit":
    case "preservation":
      return "cut";
    default:
      return DEFAULT_PROTEIN_GOAL_LEVEL;
  }
}

export interface ProteinTarget {
  goal: ProteinGoalLevel;
  goalLabel: string;
  gPerKgLow: number;
  gPerKgHigh: number;
  // The mass the band was scaled by, and which basis it is.
  massKg: number;
  massBasis: "lean" | "total";
  // Absolute grams/day band (rounded to the nearest 5 g for display honesty).
  gramsLow: number;
  gramsHigh: number;
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

// The goal-scaled per-day protein band. Prefers lean mass when a positive lean_mass_kg is
// supplied (else total bodyweight). Returns null when no bodyweight is known (nothing to
// scale by). Never prescriptive — a band the surfaces frame as informational.
export function proteinTarget(args: {
  goal: ProteinGoalLevel;
  bodyweightKg: number | null;
  leanMassKg?: number | null;
}): ProteinTarget | null {
  const useLean = args.leanMassKg != null && args.leanMassKg > 0;
  const massKg = useLean
    ? (args.leanMassKg as number)
    : args.bodyweightKg != null && args.bodyweightKg > 0
      ? args.bodyweightKg
      : null;
  if (massKg == null) return null;
  const band = GOAL_BANDS[args.goal];
  return {
    goal: args.goal,
    goalLabel: band.label,
    gPerKgLow: band.low,
    gPerKgHigh: band.high,
    massKg,
    massBasis: useLean ? "lean" : "total",
    gramsLow: round5(band.low * massKg),
    gramsHigh: round5(band.high * massKg),
  };
}

// ---- Adequacy: intake vs target -------------------------------------------

export type ProteinAdequacyStatus = "below" | "within" | "above";

export interface ProteinAdequacy {
  intake: ProteinIntake;
  target: ProteinTarget;
  status: ProteinAdequacyStatus;
}

// Combine intake + target into an adequacy verdict, or null when either is missing.
// `below` = under the band floor, `above` = over the ceiling, else `within`. For an
// `estimated` basis a `below` is NOT a definite shortfall (the intake is a floor) — the
// wording, not this status, carries that caveat (mirroring the #578 RDA-adequacy split).
export function assessProteinAdequacy(
  intake: ProteinIntake | null,
  target: ProteinTarget | null
): ProteinAdequacy | null {
  if (!intake || !target) return null;
  const status: ProteinAdequacyStatus =
    intake.grams < target.gramsLow
      ? "below"
      : intake.grams > target.gramsHigh
        ? "above"
        : "within";
  return { intake, target, status };
}

// ---- Finding identity + formatting (shared by every surface) ---------------

// The findings-bus namespace for the protein-adequacy coaching observation. One stable
// key per profile (the subject is "am I hitting my protein target?"), so a dismiss follows
// the topic. Registered in RULE_FINDING_PREFIXES so a page's prefix guard can match it.
export const PROTEIN_ADEQUACY_PREFIX = "protein-adequacy:";

export function proteinAdequacySignalKey(): string {
  return `${PROTEIN_ADEQUACY_PREFIX}shortfall`;
}

// Round a protein figure for display (whole grams).
function g(n: number): string {
  return String(Math.round(n));
}

// A phrase naming the intake's basis, for the copy.
export function proteinBasisPhrase(basis: ProteinBasis): string {
  switch (basis) {
    case "tracked":
      return "tracked intake";
    case "combined":
      return "logged foods + protein logged";
    case "logged":
      return "logged protein";
    case "estimated":
      return "logged foods";
  }
}

// The "a floor — actual likely higher" caveat that every non-tracked basis carries (the
// sum of the estimate + manual grams is still a floor; untracked foods stay invisible).
const FLOOR_CAVEAT = "a floor — actual likely higher";

// The intake summary line. Only `tracked` reads as a measured total; every other basis
// carries the floor caveat, and `combined` names the composition honestly. e.g.
// "≈120 g/day — 90 g estimated from foods + 30 g logged (a floor — actual likely higher)".
export function proteinIntakeSummary(intake: ProteinIntake): string {
  switch (intake.basis) {
    case "tracked":
      return `~${g(intake.grams)} g/day from your tracked intake`;
    case "combined":
      return `≈${g(intake.grams)} g/day — ${g(intake.estimatedGrams)} g estimated from foods + ${g(intake.loggedGrams)} g logged (${FLOOR_CAVEAT})`;
    case "logged":
      return `≈${g(intake.grams)} g/day logged (${FLOOR_CAVEAT})`;
    case "estimated":
      return `≈${g(intake.grams)} g/day from logged foods (${FLOOR_CAVEAT})`;
  }
}

// The target band line. e.g. "~130–180 g/day (1.6–2.2 g/kg lean mass, muscle gain)".
export function proteinTargetSummary(target: ProteinTarget): string {
  const massWord = target.massBasis === "lean" ? "g/kg lean mass" : "g/kg";
  return `~${g(target.gramsLow)}–${g(target.gramsHigh)} g/day (${target.gPerKgLow}–${target.gPerKgHigh} ${massWord}, ${target.goalLabel})`;
}

export function proteinAdequacyTitle(a: ProteinAdequacy): string {
  switch (a.status) {
    case "below":
      return "Protein may be below your goal range";
    case "above":
      return "Protein is above your goal range";
    case "within":
      return "Protein is in your goal range";
  }
}

// The informational, never-prescriptive detail. Every non-`tracked` basis (estimated,
// logged, combined) is stated as a floor — the shortfall is NOT asserted, since untracked
// foods stay invisible; only a `tracked` measured total states the gap directly. Always
// closes with the framing that this is informational, not prescriptive.
export function proteinAdequacyDetail(a: ProteinAdequacy): string {
  const intake = proteinIntakeSummary(a.intake);
  const target = proteinTargetSummary(a.target);
  const massNote =
    a.target.massBasis === "lean" ? " (scaled to your lean body mass)" : "";
  const isFloor = a.intake.basis !== "tracked";
  let lead: string;
  if (a.status === "below") {
    lead = isFloor
      ? `Your intake is ${intake} — below the ${target}${massNote}. Because that's a floor, your real intake may already be there; if it isn't, a little more protein helps.`
      : `Your protein is ${intake} — below the ${target}${massNote}. Nudging it up supports your goal.`;
  } else if (a.status === "above") {
    lead = `Your protein is ${intake} — above the ${target}${massNote}. That's fine for most people; no action needed.`;
  } else {
    lead = `Your protein is ${intake} — within the ${target}${massNote}. Nice.`;
  }
  return `${lead} Informational, not medical or dietary advice.`;
}

// The evidence line: the g/kg basis behind the band.
export function proteinAdequacyEvidence(a: ProteinAdequacy): string {
  return `Target ${a.target.gPerKgLow}–${a.target.gPerKgHigh} g/kg (ISSN position stand). Informational, not prescriptive.`;
}

// ---- Today gauge (issue #974): today so far · weekly average · goal band ----
//
// The band gauge on the Food tab shows THREE protein numbers in one visual: today so far
// (the primary bar), this week's daily average (a thin marker), and the goal band (a
// shaded zone). This is the model behind it — one pure assembly the gauge, the quick-add
// card, and the Telegram food-nudge status line all format ("one question, one
// computation", #221). The gather (getProteinToday) fills it from the SAME pieces the
// adequacy card reads: `todayIntake` is today's composition through the SAME proteinIntake
// engine (estimated food-group grams + quick-add grams, or a tracked reading), `target` is
// the SAME goal-scaled band, and `weeklyAverageGrams` is the adequacy computation's own
// daily-average figure — so the marker and the adequacy card can never disagree.
export interface ProteinToday {
  // Today's composition (null when nothing's been logged/tracked today yet — the bar
  // renders at 0, honest "in progress").
  todayIntake: ProteinIntake | null;
  // todayIntake?.grams ?? 0 — the primary bar's value. Today is IN PROGRESS, so a surface
  // never colors this as a shortfall mid-day.
  todayGrams: number;
  // The goal-scaled band (always present — the gather returns null without a target).
  target: ProteinTarget;
  // This week's daily-average intake — EXACTLY getProteinAdequacy(...).intake.grams for the
  // same profile (#221). Null when there's no logged intake this week.
  weeklyAverageGrams: number | null;
}

// The Telegram food-nudge protein status line (issue #974). Rendered from the SAME
// ProteinToday the gauge uses (a third formatter, never a second engine, #221). A floor
// basis (anything but a measured tracked reading) reads "at least N g" per the #767 floor
// copy discipline; a tracked reading states the figure directly. e.g.
// "Protein today · at least 55 g of ~130–180 g".
export function proteinTodayNudgeLine(t: ProteinToday): string {
  const grams = Math.round(t.todayGrams);
  const isFloor = t.todayIntake ? t.todayIntake.basis !== "tracked" : true;
  const amt = isFloor ? `at least ${grams} g` : `${grams} g`;
  const band = `~${g(t.target.gramsLow)}–${g(t.target.gramsHigh)} g`;
  return `Protein today · ${amt} of ${band}`;
}
