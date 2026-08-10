// "Did one DAY's eating reach its protein and fibre targets?" — ONE pure computation
// (#2379), no DB, no clock, no network.
//
// WHY THIS IS NOT A THIRD ENGINE. `lib/protein.ts` and `lib/fiber.ts` already model both
// nutrients end to end: the intake composition, the resolved target, and the adequacy
// verdict. This module invents NO threshold and NO second adequacy rule. It takes the two
// EXISTING verdicts for a calendar day and answers the one question a surface actually
// asks about them together — "where did this day land, and by how much did it miss?" —
// in a shape a formatter can render and a follow-up can act on.
//
// WHAT IT ADDS, and why the two engines don't already carry it: `ProteinAdequacy` states
// a band and a status; `FiberAdequacy` states an AI figure and a status. Neither states
// the GAP, because neither surface that reads them needed one — the /nutrition cards
// explain a position, they don't propose closing it. A shortfall's SIZE is the fact a
// suggestion is built from ("you were 40 g short" picks a different food from "you were
// 4 g short"), and deriving it at each call site is exactly the drift #221 forbids. So it
// is derived once, here, beside the status it belongs to.
//
// WHAT #2383 CALLS. `nutritionShortfalls(position)` — the nutrients that finished below a
// RESOLVED target, each carrying its `shortfallGrams` and whether the intake figure it was
// measured from is a floor. A curated-food follow-up needs nothing else from this side and
// must not re-derive any of it.
//
// THE FLOOR DISCIPLINE IS CARRIED, NEVER FLATTENED (#767/#976). Every non-`tracked` basis
// is a FLOOR — untracked foods stay invisible — so a shortfall measured from one is not an
// asserted fact about the person's eating. `isFloor` carries that per nutrient, the copy
// marks it with the compact trailing "+" (#1822 item 4), and the digest's demotion
// predicate reads it rather than inventing a severity of its own.

import type { FiberAdequacy } from "./fiber";
import type { MessageLine } from "./notifications/message-line";
import type { ProteinAdequacy } from "./protein";

// The two nutrients the app models end to end. Deliberately a closed union rather than a
// string: a third nutrient is a modelling decision, not a caller's.
export const NUTRIENT_KEYS = ["protein", "fiber"] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

// The reader's word for each. American spelling, matching every existing surface
// (`fiberAdequacyTitle`, the /nutrition cards, the food nudge).
export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  protein: "protein",
  fiber: "fiber",
};

// `ProteinAdequacyStatus` and `FiberAdequacyStatus` are the SAME three-value vocabulary;
// this names it once so a position can hold either without a union at every call site.
export type NutrientAdequacyStatus = "below" | "within" | "above";

// Where one nutrient finished on one day.
export interface NutrientPosition {
  nutrient: NutrientKey;
  /** The day's intake in grams, from the engine's own composition. Always > 0. */
  grams: number;
  /**
   * The FLOOR of the resolved target — protein's `gramsLow` (the band's bottom), fibre's
   * DRI Adequate Intake. The number a shortfall is measured against, and the number a
   * follow-up has to close. Never the ceiling: overshoot is not a problem for either
   * nutrient, and neither engine treats it as one.
   */
  targetGrams: number;
  /** The engine's own verdict, passed through unchanged. */
  status: NutrientAdequacyStatus;
  /**
   * How many grams short of `targetGrams` the day finished, rounded, or 0 when it did
   * not. THE fact a curated-food suggestion is sized from (#2383).
   */
  shortfallGrams: number;
  /**
   * TRUE when `grams` is a FLOOR rather than a measured total — i.e. any basis but a
   * tracked full-day reading. A `below` on a floor is "may be below", never an assertion.
   */
  isFloor: boolean;
}

// One day's position across both nutrients. A nutrient whose target does not resolve, or
// whose day carries no quantified intake, is simply absent — never a zero.
export interface NutritionDayPosition {
  /** The profile-local day this is about (YYYY-MM-DD) — #94 day attribution, not an instant. */
  date: string;
  protein: NutrientPosition | null;
  fiber: NutrientPosition | null;
}

function round(n: number): number {
  return Math.round(n);
}

// One nutrient's position from its existing adequacy verdict, or null when there is
// nothing honest to state.
//
// TWO ABSENCES, both deliberate, both "no line" rather than "zero":
//   • no verdict at all — the target did not resolve (protein with no bodyweight on
//     record; fibre below the youngest DRI band), or the day carried no intake signal.
//     A target the app had to guess at is not a target, so nothing is stated against it.
//   • a verdict whose intake is 0 g — the shape a lone unquantifiable fibre supplement
//     produces (a capsule dose, grams unknown). The day has a signal but no NUMBER, and
//     "0 g of 38 g" would be a false claim about the person's eating rather than an
//     honest report of what was logged.
function positionFrom(
  nutrient: NutrientKey,
  args: {
    grams: number;
    targetGrams: number;
    status: NutrientAdequacyStatus;
    isFloor: boolean;
  } | null
): NutrientPosition | null {
  if (!args || !(args.grams > 0)) return null;
  return {
    nutrient,
    grams: args.grams,
    targetGrams: args.targetGrams,
    status: args.status,
    // Measured from the ROUNDED figures the copy prints, so a line can never say
    // "40 g+ of 45 g — 4 g short". Clamped at 0 for every non-`below` status.
    shortfallGrams:
      args.status === "below"
        ? Math.max(0, round(args.targetGrams) - round(args.grams))
        : 0,
    isFloor: args.isFloor,
  };
}

// The day's position, composed from the two verdicts the existing gathers already return.
// Returns null when NEITHER nutrient could be positioned — a day with no food logged, or a
// profile with no resolvable target, produces no position at all rather than an empty one.
export function nutritionDayPosition(args: {
  date: string;
  protein: ProteinAdequacy | null;
  fiber: FiberAdequacy | null;
}): NutritionDayPosition | null {
  const protein = positionFrom(
    "protein",
    args.protein
      ? {
          grams: args.protein.intake.grams,
          // The band's FLOOR: `assessProteinAdequacy` calls anything under it `below`.
          targetGrams: args.protein.target.gramsLow,
          status: args.protein.status,
          isFloor: args.protein.intake.basis !== "tracked",
        }
      : null
  );
  const fiber = positionFrom(
    "fiber",
    args.fiber
      ? {
          grams: args.fiber.intake.grams,
          // The DRI Adequate Intake; `gramsHigh` is a soft GI-comfort ceiling, not a goal.
          targetGrams: args.fiber.target.grams,
          status: args.fiber.status,
          isFloor: args.fiber.intake.basis !== "tracked",
        }
      : null
  );
  if (!protein && !fiber) return null;
  return { date: args.date, protein, fiber };
}

// THE #2383 ENTRY POINT: the nutrients that finished below a resolved target, in declared
// order, each carrying the gap to close and whether that gap is asserted or hedged. Empty
// on a day that met both — which is also the day that states nothing.
export function nutritionShortfalls(
  position: NutritionDayPosition | null
): NutrientPosition[] {
  if (!position) return [];
  return NUTRIENT_KEYS.map((k) => position[k]).filter(
    (p): p is NutrientPosition => p != null && p.status === "below"
  );
}

// ---- The copy -------------------------------------------------------------

// One nutrient's figure against its target: "protein 84 g+ of 130 g".
//
// The trailing "+" is the ESTABLISHED floor marker (#1822 item 4 unstacked the wordy
// hedges into it), so a floor basis is legible in one character and a measured total
// states its figure exactly. No second caveat sentence — the digest is a glance.
export function nutrientPositionPhrase(p: NutrientPosition): string {
  const amount = `${round(p.grams)} g${p.isFloor ? "+" : ""}`;
  return `${NUTRIENT_LABELS[p.nutrient]} ${amount} of ${round(p.targetGrams)} g`;
}

// The digest's ONE nutrition line, IN ITS PARTS (#2391), or null when the day says
// nothing.
//
// WHEN IT APPEARS: only when at least one nutrient finished BELOW a resolved target. A day
// that met its targets is unremarkable and emits NOTHING — a line that always renders is
// how a digest teaches people to stop reading it. So this makes a typical morning SHORTER,
// not longer.
//
// WHAT IT SAYS: the short nutrients only, with their figures. Naming the one that landed
// fine alongside would be exactly the routine content the silence above is protecting.
//
// WHY IT IS PARTS AND NOT TEXT. "Nutrition" is the HEAD — a section noun — and each short
// nutrient is one NOTE. That is the entire line: `notes` is the grammar's repeating group
// and nothing requires its entries to be heterogeneous, so N facts of the SAME kind are N
// notes rather than a second shape (the `·` between two nutrients is the same job as the
// `·` between a cause and a deadline). The formatter then owns every separator, this
// module types none, and the per-item floor hedge ("+") stays inside its own note — the
// only place it can be right when the two nutrients disagree about it.
//
// THE HEAD TAKES NO COLON. A colon introduces a head's own value ("Weight: 84 kg"); this
// head has none, so its first qualifier takes the em dash like every other line.
//
// NO GLYPH: the digest's Yesterday section stamps 🍽️ at the call site, as it does for
// every one of its lines.
//
// WHAT IT DOES NOT SAY: adequacy is an OBSERVATION, not an obligation (#992). No streak,
// no "you failed", no instruction — the number against the target, and stop. Protein and
// fibre share the line because they are one question asked of one day's eating, from one
// gather; splitting them would double the digest's nutrition footprint for no added
// meaning.
export function nutritionDigestLine(
  position: NutritionDayPosition | null
): MessageLine | null {
  const short = nutritionShortfalls(position);
  if (short.length === 0) return null;
  return { head: "Nutrition", notes: short.map(nutrientPositionPhrase) };
}
