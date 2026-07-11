// Pure barbell plate-loading math (issue #314) — the greedy plate breakdown and
// the loaded-bar total, plus the policy constants (plate denominations, standard
// bar weights, the per-side plate cap). Lifted out of components/PlateBuilderModal
// so the pure-logic test tier can reach it and a second surface (a "how to load
// this set" hint, or a logged set's plate breakdown) can reuse it verbatim.
//
// Everything here works in DISPLAY units (kg or lb) — the plate denominations are
// each "the standard set" in their own unit system, so conversion never enters the
// math. PLATE_COLORS and the SVG geometry stay in the component (pure display).

import type { WeightUnit } from "@/lib/settings";
import { round } from "@/lib/units";

// Common plate denominations per side, largest first, in each display unit.
export const PLATE_DENOMINATIONS: Record<WeightUnit, number[]> = {
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
  lb: [45, 35, 25, 10, 5, 2.5, 1.25],
};

// The default Olympic bar, by convention 20 kg / 45 lb. (These differ slightly
// in absolute terms, but each is "the standard bar" in its own unit system.)
// It's a UI default rather than a saved implement, so selecting it tags no
// equipment (barId stays null).
export const STANDARD_BAR_WEIGHT: Record<WeightUnit, number> = {
  kg: 20,
  lb: 45,
};

// The per-side plate cap the greedy fill honors and the builder enforces.
export const MAX_PLATES_PER_SIDE = 10;

// Greedy plate breakdown for a target total: the fewest plates per side (largest
// denomination first) that reach `target` without going over, given the bar's
// weight. Used to pre-load the builder from a weight already typed into the set.
// Any unloadable remainder (a sub-plate target, or a leftover finer than the
// smallest plate) is simply left off — the breakdown never overshoots. Per-side
// sums are re-rounded to 2 decimals so repeated fractional plates don't accrue
// float drift.
export function platesForWeight(
  target: number,
  barWeight: number,
  unit: WeightUnit
): number[] {
  let perSide = round((target - barWeight) / 2, 2);
  if (!(perSide > 0)) return [];
  const out: number[] = [];
  for (const p of PLATE_DENOMINATIONS[unit]) {
    while (perSide >= p && out.length < MAX_PLATES_PER_SIDE) {
      out.push(p);
      perSide = round(perSide - p, 2);
    }
    if (out.length >= MAX_PLATES_PER_SIDE) break;
  }
  return out;
}

// Sum of the plates loaded on ONE side, re-rounded to 2 decimals so repeated
// fractional plates (e.g. 1.25 + 2.5) don't accumulate float drift.
export function platesPerSideWeight(platesPerSide: number[]): number {
  return round(
    platesPerSide.reduce((s, p) => s + p, 0),
    2
  );
}

// Total weight of a symmetrically loaded barbell: bar + 2 × (plates per side).
// The plates count twice because each denomination is loaded on both sides.
export function barbellTotal(
  barWeight: number,
  platesPerSide: number[]
): number {
  return round(barWeight + platesPerSideWeight(platesPerSide) * 2, 2);
}
