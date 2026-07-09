import {
  filterCategoryFor,
  type VaccineAssessment,
  type VaccineStatus,
} from "./immunization-status";

// Shared status → badge/label styling for every surface that shows an
// immunization status pill: the immunizations master table, the per-vaccine
// detail view, and the profile passport's immunizations table (issue #185). It
// lives in lib/ (not the immunizations page dir) so a Server Component shared by
// the authed + public passport can reuse the identical pill without importing
// app-route code. Pure — just class/label maps.

export const STATUS_BADGE: Record<VaccineStatus, string> = {
  complete:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  // Brand green so an actively-current status reads distinct from a finished
  // series (emerald).
  up_to_date:
    "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  due: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  overdue: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  unknown: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  not_recommended:
    "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400",
  declined: "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400",
};

export const STATUS_TEXT: Record<VaccineStatus, string> = {
  complete: "Complete",
  up_to_date: "Up to date",
  due: "Due",
  overdue: "Overdue",
  unknown: "No record",
  not_recommended: "N/A",
  declined: "Declined",
};

const IMMUNE_BADGE =
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";

// The pill class + label from a raw status plus whether it reads as "Immune"
// (a titer/override-driven completion). The passport carries a precomputed
// `isImmune` flag in its view-model, so it resolves the pill without a full
// VaccineAssessment.
export function statusBadgeParts(
  status: VaccineStatus,
  isImmune: boolean
): { cls: string; text: string } {
  if (isImmune) return { cls: IMMUNE_BADGE, text: "Immune" };
  return { cls: STATUS_BADGE[status], text: STATUS_TEXT[status] };
}

// The badge for an assessment: usually the raw status, but a titer/override-
// driven completion reads "Immune" (its own emerald pill) rather than plain
// "Complete", matching the status filter's buckets.
export function statusBadge(a: VaccineAssessment): {
  cls: string;
  text: string;
} {
  return statusBadgeParts(a.status, filterCategoryFor(a) === "immune");
}
