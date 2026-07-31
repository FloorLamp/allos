"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";

// The phone chrome shape a surface takes when its controls cost more of the first
// screen than they are worth: one line naming the CONTEXT — "Overview · 90D ▾",
// "All · Through today ▾" — that expands to the full controls on tap.
//
// Extracted from components/TrendsContextBar.tsx (#1485 F) when the Timeline's
// filter block needed the same treatment (#1517 B). It is deliberately the COLLAPSE
// only: placement — sticky and riding the shell chrome, or an ordinary block that
// scrolls away — is the caller's, passed in as `className` plus whatever data
// attributes its own state machine publishes. Trends' bar pins under the app bar
// because a chart is unreadable without its window named; the Timeline's filter
// bar scrolls away on purpose, so the day nav can have the pinned slot instead.
//
// WHY THE LABEL AND NOT THE CONTROL. The controls sit above the content because
// they are its interpretation context. But what has to be VISIBLE is the context
// LABEL — the controls themselves are touched about once a session and scrolled
// past on every visit, and at 390px they cost 100–150px of the first screen. So the
// label is never hidden (it IS the toggle) and the controls come on demand.
//
// ONE TREE, NOT A FORK. Below `sm` this renders the collapsed bar and hides the
// controls until tapped; from `sm` up the toggle disappears and the controls are
// simply always shown, in the layout they always had. That is responsive styling of
// the SAME children — one instance each, never a `hidden sm:*` / `sm:hidden` pair of
// hand-mirrored copies (the sidebar/drawer precedent). It also means the controls
// are in the DOM at every viewport, so a deep link's server-rendered state is intact
// before hydration.
export default function ContextBar({
  idPrefix,
  label,
  controls,
  className = "",
  rootProps,
}: {
  // Names this bar's testids and its controls' element id: `<idPrefix>-bar`,
  // `-toggle`, `-label`, `-controls`.
  idPrefix: string;
  // The one-line context label, e.g. "Overview · 90D" (lib/context-label.ts).
  label: string;
  // What the bar collapses.
  controls: ReactNode;
  // Placement + surface classes, owned by the caller.
  className?: string;
  // Extra attributes for the root — a sticky caller's `data-hidden`/`data-ready`.
  rootProps?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const controlsId = `${idPrefix}-controls`;
  return (
    <div
      data-testid={`${idPrefix}-bar`}
      data-expanded={open ? "true" : "false"}
      {...rootProps}
      className={className}
    >
      <button
        type="button"
        data-testid={`${idPrefix}-toggle`}
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 py-2 text-left text-sm font-medium text-slate-600 sm:hidden dark:text-slate-300"
      >
        <span data-testid={`${idPrefix}-label`} className="truncate">
          {label}
        </span>
        <IconChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div
        id={controlsId}
        data-testid={controlsId}
        className={`${open ? "block pb-2" : "hidden"} sm:block sm:pb-0`}
      >
        {controls}
      </div>
    </div>
  );
}
