// Shared pace presentation for outcome goals and weekly frequency targets.
//
// The domains own distinct verdict vocabularies: a recurring week can be met,
// on pace, or behind, while a dated outcome goal can additionally fail after
// its deadline. They share colors, not business semantics, so the palette lives
// here instead of making cadence consumers import the outcome-goal module.

export type ProgressPaceTone = "met" | "on-pace" | "behind" | "failed";

export const PACE_FILL_CLASS: Record<ProgressPaceTone, string> = {
  // The 600 step, not 500 (#2719 review): progress bars and routine-chip
  // squares are the same green as links and the active tab now, so a goals
  // page shows one accent green instead of stacking a brighter "data green"
  // on top of it. (Under the selectable palettes these re-point with their
  // ramps — olive/lime — like every other brand/emerald step.)
  met: "bg-emerald-600",
  "on-pace": "bg-brand-600",
  behind: "bg-amber-500",
  failed: "bg-rose-500",
};

export const PACE_BORDER_CLASS: Record<ProgressPaceTone, string> = {
  met: "border-emerald-400 dark:border-emerald-700",
  "on-pace": "border-brand-400 dark:border-brand-700",
  behind: "border-amber-400 dark:border-amber-600",
  failed: "border-rose-400 dark:border-rose-800",
};

export const PACE_BADGE_CLASS: Record<ProgressPaceTone, string> = {
  met: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "on-pace":
    "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  behind: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};
