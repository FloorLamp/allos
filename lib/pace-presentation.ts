// Shared pace presentation for outcome goals and weekly frequency targets.
//
// The domains own distinct verdict vocabularies: a recurring week can be met,
// on pace, or behind, while a dated outcome goal can additionally fail after
// its deadline. They share colors, not business semantics, so the palette lives
// here instead of making cadence consumers import the outcome-goal module.

import { verdictBadge, verdictFill } from "./chart-colors";

// KEPT as its own vocabulary rather than aliased to VerdictTone (#5187): `met`
// and `on-pace` are not the same verdict — one is done, one is on track — and
// the surface paints them differently on purpose. So the type stays and the
// THREE entries that are plain verdicts read the shared palette, while
// `on-pace` keeps the brand accent green the #2719 review chose for it.
export type ProgressPaceTone = "met" | "on-pace" | "behind" | "failed";

export const PACE_FILL_CLASS: Record<ProgressPaceTone, string> = {
  // The 600 step, not 500 (#2719 review): progress bars and routine-chip
  // squares are the same green as links and the active tab now, so a goals
  // page shows one accent green instead of stacking a brighter "data green"
  // on top of it.
  met: verdictFill.good.class,
  "on-pace": "bg-brand-600",
  // `bg-amber-500` and `bg-rose-500` were 1.99:1 and 3.49:1 on the light
  // surface; the palette's per-theme pair clears 3:1 on both.
  behind: verdictFill.warn.class,
  failed: verdictFill.bad.class,
};

export const PACE_BORDER_CLASS: Record<ProgressPaceTone, string> = {
  met: "border-emerald-400 dark:border-emerald-700",
  "on-pace": "border-brand-400 dark:border-brand-700",
  behind: "border-amber-400 dark:border-amber-600",
  failed: "border-rose-400 dark:border-rose-800",
};

export const PACE_BADGE_CLASS: Record<ProgressPaceTone, string> = {
  met: verdictBadge.good.class,
  "on-pace":
    "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  behind: verdictBadge.warn.class,
  failed: verdictBadge.bad.class,
};
