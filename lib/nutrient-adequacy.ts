// The nutrient-adequacy substrate (issue #4485) — the ONE place a tracked nutrient's
// source precedence, its winning source, the period the figure describes, and the
// resulting floor/caveat are computed, TOGETHER with the figure itself. Pure: no DB, no
// clock, no network.
//
// WHY IT EXISTS. `lib/protein.ts` and `lib/fiber.ts` each answered the same four
// questions in their own words — where do readings come from, which source wins, when
// does a caveat show, what is the goal — and each pairwise generalisation (#4127 taking
// #3903's rule to fiber) fixed one divergence while leaving the pattern that produces
// the next. The per-nutrient module now DECLARES its answers; this module computes them.
//
// THE RULED PRECEDENCES ARE ENCODED HERE, NEVER CHANGED. `larger-wins` is #3903's
// `max(dailyTracked, estimated + logged)` for protein, generalised to fiber pairwise by
// #4127. Both sides are floors on the same true total, so their max is a floor too:
// nothing is double-counted (a SUM was rejected — a shake entered in both places would
// count twice) and nothing is discarded (the old override was rejected — it hid the
// profile's own logging). Changing a ruled precedence is an owner decision, not a
// refactor's; a declaration may only encode one.
//
// THE PERIOD IS AN INPUT, NOT A GUESS (#4145). The same arithmetic answers three
// different questions — today, a completed past day, and a multi-day aggregate — and a
// figure alone cannot tell them apart. `basis !== "tracked"` was therefore the wrong
// floor predicate at three sites at once: it under-hedged a tracked TODAY (an
// integration writes one sample per meal as it syncs, so at 09:00 the reading is
// breakfast) and over-hedged a COMPLETE past day whose tracked reading won the max (a
// full-day measured total is not a floor, whatever the food log also holds). Both
// answers need BOTH inputs — whether the day is still accumulating, and which side of
// the precedence won — so a period is required to compose an intake at all.

import { foodGroupBySlug } from "./food-groups";

// ---- The declaration -------------------------------------------------------

// How a nutrient's INDEPENDENT sources combine. A named kind, so the divergence between
// nutrients is a declared property rather than a rediscovered surprise. Adding a kind
// (#4148's hydration SUM semantics, when that lane lands its declaration) is a compile
// error in `precedenceTotal` until it is implemented — which is the point.
export type NutrientPrecedenceKind = "larger-wins";

// Which side of the precedence a source sits on: a reading from OUTSIDE the app, or a
// component of the app's own ledger. The in-app components sum; the two SIDES do not.
export type NutrientSourceSide = "tracked" | "in-app";

// The food-group catalog column a nutrient's estimated floor is summed from.
export type NutrientCatalogColumn = "protein_g" | "fiber_g";

// How a target is judged — the goal shape the #4485 audit asks a declaration to carry.
// `range` scores `below` against the BOTTOM of a band (protein's `gramsLow`); `floor`
// scores it against a single adequate-intake figure (fiber's DRI AI). The difference is
// declared here rather than surviving as two comparison lines in two modules.
export type NutrientGoalShape = "range" | "floor";

// A nutrient's answers to the four questions. `precedence` has no default: a nutrient
// that does not declare one does not compile.
export interface NutrientDeclaration<K extends string> {
  nutrient: string;
  precedence: NutrientPrecedenceKind;
  goalShape: NutrientGoalShape;
  column: NutrientCatalogColumn;
  // Every source the nutrient has, and the side it sits on.
  sources: Readonly<Record<K, NutrientSourceSide>>;
}

// ---- The period ------------------------------------------------------------

// WHAT the figure describes. A day-complete boolean is NOT a weekly model: an aggregate
// has to say how many days it spans and whether one of them is still accumulating, so
// the union makes that unstatable-by-omission.
export type NutrientPeriod =
  | { kind: "today" }
  | { kind: "past-day" }
  | { kind: "aggregate"; days: number; includesToday: boolean };

export const TODAY_PERIOD: NutrientPeriod = { kind: "today" };

// The period of ONE calendar day, resolved against the profile's today. A date at or
// after today is still accumulating (a future date cannot be more complete than today).
export function dayPeriod(date: string, todayStr: string): NutrientPeriod {
  return date >= todayStr ? { kind: "today" } : { kind: "past-day" };
}

// The period of a multi-day mean, e.g. a week-to-date average.
export function aggregatePeriod(
  days: number,
  includesToday: boolean
): NutrientPeriod {
  return { kind: "aggregate", days, includesToday };
}

// ---- The result ------------------------------------------------------------

// Which side of the precedence produced the figure. A tie goes to `tracked`: the two
// sides are equal, and the measured reading is the one that can be a COMPLETE total.
export type NutrientWinner = "tracked" | "in-app" | "none";

// Why the figure is a floor on the true intake. Each reason is independently true, and
// a surface names the ones it has rather than choosing one hedge for all states.
export type NutrientFloorReason =
  // Untracked foods (and unlogged doses) stay invisible, so the app's own ledger is a
  // floor by construction.
  | "in-app-ledger"
  // Today's tracked reading is a RUNNING PARTIAL — an integration writes one sample per
  // meal as it syncs.
  | "unsent-meals"
  // A confirmed dose was recorded whose grams could not be quantified (#4155), so it
  // contributes 0 g to a figure the person nonetheless earned.
  | "unquantified-dose";

export interface NutrientFloor {
  // True when the figure understates the true intake for the period it describes.
  isFloor: boolean;
  reasons: readonly NutrientFloorReason[];
  // An aggregate caveat that is NOT a floor claim about a day: the window still holds a
  // day in progress, so the mean will move. Today is one seventh of a week, not the
  // whole of it, so the running-partial hedge a single day earns does not transfer.
  windowInProgress: boolean;
}

// The shared result: the figure AND everything a surface would otherwise re-derive from
// it. Every per-nutrient intake type extends this, so the period, the contributions, the
// winner and the floor arrive with the grams they describe.
export interface NutrientIntakeResult<K extends string> {
  // The per-period grams the precedence produced.
  grams: number;
  // What each declared source contributed, clamped at 0. The app's OWN components stay
  // visible even when the tracked reading won, so a surface can name the composition
  // honestly; they are NOT a decomposition of `grams`.
  contributions: Readonly<Record<K, number>>;
  // The two sides the precedence ran between.
  trackedGrams: number;
  inAppGrams: number;
  winner: NutrientWinner;
  // A confirmed but unquantifiable contribution was recorded (#4155). Carried on EVERY
  // basis: the caveat is about the day, not about which columns fed the sum.
  unquantified: boolean;
  period: NutrientPeriod;
  floor: NutrientFloor;
}

// ---- The engine ------------------------------------------------------------

function precedenceTotal(
  kind: NutrientPrecedenceKind,
  trackedGrams: number,
  inAppGrams: number
): number {
  switch (kind) {
    case "larger-wins":
      return Math.max(trackedGrams, inAppGrams);
  }
}

// The floor/caveat, from the period and the winner TOGETHER (#4145 — neither input
// settles it alone).
//
//  - The in-app ledger is a floor whenever the figure rests on it: always while a day is
//    still accumulating (both ledgers are open), and otherwise only when it WON, because
//    a completed tracked total that won the max is the whole day.
//  - A tracked reading is a floor only while its day is still accumulating.
//  - An unquantified dose is a floor on every basis and in every period.
export function nutrientFloor(args: {
  trackedPresent: boolean;
  inAppPresent: boolean;
  winner: NutrientWinner;
  unquantified: boolean;
  period: NutrientPeriod;
}): NutrientFloor {
  const accumulating = args.period.kind === "today";
  const reasons: NutrientFloorReason[] = [];
  if (args.inAppPresent && (accumulating || args.winner === "in-app"))
    reasons.push("in-app-ledger");
  if (args.trackedPresent && accumulating) reasons.push("unsent-meals");
  if (args.unquantified) reasons.push("unquantified-dose");
  return {
    isFloor: reasons.length > 0,
    reasons,
    windowInProgress:
      args.period.kind === "aggregate" && args.period.includesToday,
  };
}

// Compose one nutrient's intake for one period. Each input is an already-per-period
// figure the gather computed (a day's total, or a mean over the days that carry it).
// Returns null when no source has any signal and nothing unquantifiable was recorded —
// a lone unknown-unit dose still surfaces (grams 0) so its note can render.
export function composeNutrientIntake<K extends string>(
  declaration: NutrientDeclaration<K>,
  args: {
    grams: Readonly<Record<K, number | null | undefined>>;
    unquantified?: boolean;
    period: NutrientPeriod;
  }
): NutrientIntakeResult<K> | null {
  const contributions = {} as Record<K, number>;
  let trackedGrams = 0;
  let inAppGrams = 0;
  for (const key of Object.keys(declaration.sources) as K[]) {
    const raw = args.grams[key];
    const value = raw != null && raw > 0 ? raw : 0;
    contributions[key] = value;
    if (declaration.sources[key] === "tracked") trackedGrams += value;
    else inAppGrams += value;
  }
  const unquantified = !!args.unquantified;
  const trackedPresent = trackedGrams > 0;
  // An unquantifiable dose is in-app SIGNAL even though it is 0 g — the day is not one
  // the app has nothing to say about.
  const inAppPresent = inAppGrams > 0 || unquantified;
  if (!trackedPresent && !inAppPresent) return null;
  const winner: NutrientWinner = trackedPresent
    ? trackedGrams >= inAppGrams
      ? "tracked"
      : "in-app"
    : inAppGrams > 0
      ? "in-app"
      : "none";
  return {
    grams: precedenceTotal(declaration.precedence, trackedGrams, inAppGrams),
    contributions,
    trackedGrams,
    inAppGrams,
    winner,
    unquantified,
    period: args.period,
    floor: nutrientFloor({
      trackedPresent,
      inAppPresent,
      winner,
      unquantified,
      period: args.period,
    }),
  };
}

// ---- The estimated food-group floor ----------------------------------------

// A group's summed servings, as the #579 rollup produces (GroupServingTotal is a
// superset). One shape for every nutrient — the rollup does not vary by nutrient.
export interface NutrientServing {
  slug: string;
  servings: number;
}

// Sum a nutrient's grams over a set of food-group servings: servings × the catalog's
// per-serving figure, skipping groups the catalog marks as non-bearing (fruit/water/
// sweets/alcohol for protein, animal foods for fiber) and any retired/unknown slug. A
// FLOOR — untracked foods are invisible. Pure over the shared rollup, so the estimate
// and the servings card agree.
export function estimatedNutrientGrams(
  servings: readonly NutrientServing[],
  column: NutrientCatalogColumn
): number {
  let grams = 0;
  for (const s of servings) {
    if (!(s.servings > 0)) continue;
    const g = foodGroupBySlug(s.slug)?.[column];
    if (g != null) grams += s.servings * g;
  }
  return grams;
}

// ---- Adequacy: the figure against the declared goal shape ------------------

// `ProteinAdequacyStatus` and `FiberAdequacyStatus` are the SAME three-value vocabulary.
export type NutrientAdequacyStatus = "below" | "within" | "above";

// The band a goal shape resolves to: `low` is the number a shortfall is measured
// against (a RANGE's bottom, or a FLOOR goal's adequate-intake figure), `high` the
// ceiling past which the figure reads `above`.
export interface NutrientGoalBand {
  low: number;
  high: number;
}

// The one comparison. `below` is under the band's bottom, `above` over its ceiling.
// For a floor basis a `below` is NOT a definite shortfall — the WORDING carries that
// caveat, never this status (the #578 RDA-adequacy split, kept).
export function nutrientAdequacyStatus(
  grams: number,
  band: NutrientGoalBand
): NutrientAdequacyStatus {
  return grams < band.low ? "below" : grams > band.high ? "above" : "within";
}

// ---- Shared wording pieces -------------------------------------------------

// Round a gram figure for display (whole grams).
export function fmtGrams(n: number): string {
  return String(Math.round(n));
}

// The "a floor — actual likely higher" caveat every floor basis carries.
export const FLOOR_CAVEAT = "a floor — actual likely higher";
