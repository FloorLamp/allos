// Shared visual language for scheduled and as-needed dose actions. The action
// semantics differ (take/skip versus log-now/log-earlier), but both use the same
// height, standard app button radius, typography, spacing, focus treatment, and
// state colors.
export const DOSE_ACTION_BASE =
  "tap-target flex h-8 shrink-0 items-center text-sm font-medium transition disabled:opacity-50";

export const DOSE_ACTION_LABEL = `${DOSE_ACTION_BASE} gap-2 rounded-lg px-3`;
export const DOSE_ACTION_ICON = `${DOSE_ACTION_BASE} w-8 justify-center rounded-lg`;

export const DOSE_ACTION_NEUTRAL =
  "border border-black/10 bg-white/70 text-slate-600 hover:bg-white dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:bg-ink-750";
export const DOSE_ACTION_RESOLVED =
  "cursor-default border border-black/10 bg-white/70 text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300";
export const DOSE_ACTION_MUTED =
  "border border-black/5 bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-600 dark:border-white/5 dark:bg-ink-900/60 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300";
export const DOSE_ACTION_BRAND =
  "border border-brand-600 bg-brand-600 text-white hover:border-brand-700 hover:bg-brand-700";
export const DOSE_ACTION_AMBER =
  "cursor-default border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300";
