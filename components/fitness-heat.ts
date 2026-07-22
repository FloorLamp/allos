// Shared theme-aware green→red heat classes for the Fitness-check surfaces (#1132) — the
// grid tiles AND the domain bars format over the SAME HeatTone buckets, so the color
// language can't drift between surfaces (#221 at the formatter layer). Green = favorable on
// every tile; grey (neutral) is the only "no reference" color. Legible in light AND dark.

import type { HeatTone } from "@/lib/fitness-tile";

// Tile fill: a soft tinted background + border + text, per tone.
export const TONE_TILE: Record<HeatTone, string> = {
  great:
    "bg-emerald-100 border-emerald-300 text-emerald-900 dark:bg-emerald-500/20 dark:border-emerald-500/40 dark:text-emerald-100",
  good: "bg-lime-100 border-lime-300 text-lime-900 dark:bg-lime-500/20 dark:border-lime-500/40 dark:text-lime-100",
  mid: "bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-500/20 dark:border-amber-500/40 dark:text-amber-100",
  weak: "bg-orange-100 border-orange-300 text-orange-900 dark:bg-orange-500/20 dark:border-orange-500/40 dark:text-orange-100",
  bad: "bg-rose-100 border-rose-300 text-rose-900 dark:bg-rose-500/20 dark:border-rose-500/40 dark:text-rose-100",
  neutral:
    "bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-800/60 dark:border-slate-700 dark:text-slate-400",
};

// Bar fill (the domain-summary strip + any progress bar) — solid, per tone.
export const TONE_BAR: Record<HeatTone, string> = {
  great: "bg-emerald-500",
  good: "bg-lime-500",
  mid: "bg-amber-500",
  weak: "bg-orange-500",
  bad: "bg-rose-500",
  neutral: "bg-slate-300 dark:bg-slate-600",
};
