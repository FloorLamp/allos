"use client";

import { useState } from "react";

// A block that is FOLDED on a phone and fully rendered from `sm` up (issue #1578).
//
// WHY. Results › Biomarkers is an index (#1499/#1581), and an index only works if its
// first entry is reachable on the first screen. Two cards sit above it by design —
// the starred lens you authored (#1455) and the biological-age hero (#209) — and at
// 390px each renders one full-width item per element with no ceiling, so between them
// they pushed the first panel header roughly 1.5k px down. Neither card is wrong;
// they are just uncapped on the one viewport where vertical space is the scarce
// resource.
//
// ONE CONTENT TREE (AGENTS.md responsive-surface rule). There is no phone variant of
// either card: the same authored children render at every width, and the fold is
// purely a visibility decision. Above `sm` the folded slot is `display: contents`, so
// its children are laid out by the PARENT exactly as if this wrapper were not there —
// which is what lets the starred card keep ONE grid whose tiles flow across two and
// three columns instead of splitting into a shown grid and an overflow grid that
// would break the desktop rhythm. Below `sm` the slot is `display: none` until the
// reader taps.
//
// The toggle is `sm:hidden` for the same reason: from `sm` up there is nothing folded
// to reveal, so offering the control would be a lie.
export default function PhoneFold({
  // The always-visible part. Rendered inside the same `containerClassName` wrapper as
  // the folded part, so a grid/list parent treats both as its own children.
  children,
  // The part hidden below `sm` until expanded.
  folded,
  // Layout for the wrapper holding both parts (e.g. the starred card's grid classes).
  // Omit for a plain block.
  containerClassName,
  // The toggle's collapsed and expanded copy. Say how much is behind it — "Show all
  // 9 starred" answers "is this worth a tap?" and a bare "Show more" does not.
  showLabel,
  hideLabel,
  testId,
}: {
  children?: React.ReactNode;
  folded: React.ReactNode;
  containerClassName?: string;
  showLabel: string;
  hideLabel: string;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `${testId}-body`;
  return (
    <div data-testid={testId} data-expanded={expanded ? "true" : "false"}>
      <div className={containerClassName}>
        {children}
        <div
          id={bodyId}
          data-testid={bodyId}
          className={expanded ? "contents" : "hidden sm:contents"}
        >
          {folded}
        </div>
      </div>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 w-full rounded-lg border border-black/5 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-slate-50 sm:hidden dark:border-white/10 dark:text-brand-400 dark:hover:bg-ink-800/60"
      >
        {expanded ? hideLabel : showLabel}
      </button>
    </div>
  );
}
