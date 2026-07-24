"use client";

import type { ReactNode } from "react";
import type { CheckInSectionId } from "@/lib/checkin-sections";

// The ONE shared section grammar for the recomposed "How are you today?" check-in
// card (issue #1314): a label + a glanceable collapsed summary + an identically-
// styled expander, replacing the three ad-hoc <details> the card had accreted. Every
// section renders a live one-liner AT REST (collapsed state is informative — the card
// reads as a status panel and opens only for input), carries `aria-expanded` on its
// toggle, and uses the consistent `checkin-section-<id>` / `-toggle` / `-summary` /
// `-body` testid scheme.
//
// Two shapes, one component:
//   • expandable (Rate / Context / Act): a label + summary row with a toggle; the
//     body (children) shows only when expanded.
//   • non-expandable (Report): the door/escalation content renders inline at rest —
//     there is nothing to collapse (its #1300 quick-log twin isn't built yet).
//
// The Rate section passes a custom `header` (the hero face row) instead of the plain
// label+summary, so the face row stays FIRST in DOM order and one tap still completes
// the check-in without any expansion (the hero contract).
export default function CheckInSection({
  id,
  label,
  summary,
  header,
  expandable = true,
  expanded = false,
  onToggle,
  toggleLabel = "Edit",
  children,
  first = false,
}: {
  id: CheckInSectionId;
  // The section noun (omitted when a custom `header` is supplied).
  label?: string;
  // The glanceable collapsed one-liner (omitted when a custom `header` is supplied).
  summary?: string;
  // A custom at-rest header (the Rate hero face row); replaces label+summary.
  header?: ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  children?: ReactNode;
  // Drop the top divider for the first section in the card.
  first?: boolean;
}) {
  const showBody = expandable ? expanded : true;
  return (
    <div
      data-testid={`checkin-section-${id}`}
      className={
        first ? "" : "mt-3 border-t border-black/5 pt-3 dark:border-white/5"
      }
    >
      <div className="flex items-start justify-between gap-2">
        {header ?? (
          <div className="min-w-0">
            <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              {label}
            </span>
            <span
              data-testid={`checkin-section-${id}-summary`}
              className="block truncate text-xs text-slate-500 dark:text-slate-400"
            >
              {summary}
            </span>
          </div>
        )}
        {expandable ? (
          <button
            type="button"
            data-testid={`checkin-section-${id}-toggle`}
            aria-expanded={expanded}
            onClick={onToggle}
            className="shrink-0 text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            {expanded ? "Less" : toggleLabel}
          </button>
        ) : null}
      </div>
      {showBody && children ? (
        <div data-testid={`checkin-section-${id}-body`} className="mt-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
