"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { useShellChrome } from "@/components/useShellChrome";

// The Trends hub's phone chrome (issue #1485 F): the range pills and the tab strip
// collapse into ONE line — "Overview · 90D ▾" — that expands to the full controls
// on tap.
//
// WHY THE LABEL AND NOT THE CONTROL. The pills and tabs sit above the charts
// because they are the charts' interpretation context: a slope reads differently
// over 7D than over all time. But the thing that has to be VISIBLE is the context
// LABEL — the controls themselves are touched about once a session and scrolled
// past on every visit, and at 390px they cost ~130px of the first screen before a
// single chart. So the label is never hidden (it IS the toggle) and the controls
// come on demand. The invariant this exists to hold: no chart on this page is ever
// rendered without its window named.
//
// ONE TREE, NOT A FORK. Below `sm` this renders the collapsed bar and hides the
// controls until tapped; from `sm` up the toggle disappears and the controls are
// simply always shown, in the layout they always had. That is responsive styling of
// the SAME children — the pills, the saved views and the tab strip are one instance
// each, never a `hidden sm:*` / `sm:hidden` pair of hand-mirrored copies (the
// sidebar/drawer precedent). It also means the controls are in the DOM at every
// viewport, so a deep link's server-rendered state is intact before hydration.
//
// RIDING THE SHELL CHROME (#1416). On a phone the bar is sticky directly beneath
// the app's top bar and shares its state: scroll down and both slide away, scroll up
// and both return, so mid-page the compact label is still there naming the window.
// It reads the SAME `useShellChrome()` machine the bar itself does rather than
// re-deriving scroll direction — one question, one computation — and parks at
// `--shell-chrome-h`, the height that component publishes (see app/globals.css
// `.sub-chrome`). From `sm` up it drops to static and nothing sticks.
//
// The tab strip stays HERE and is deliberately not a bottom sheet: primary
// navigation stays discoverable, and the bottom edge belongs to the workout dock
// (the #1542 bottom-edge layer contract). The custom-range editor keeps its own
// #1455 "Custom…" collapse inside the expanded controls.
export default function TrendsContextBar({
  label,
  controls,
}: {
  // The one-line context label, e.g. "Overview · 90D" (lib/trends-context.ts).
  label: string;
  // The range pills + saved views + the tab strip: what the bar collapses.
  controls: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { hidden, ready } = useShellChrome();
  return (
    <div
      data-testid="trends-context-bar"
      data-hidden={hidden ? "true" : "false"}
      data-expanded={open ? "true" : "false"}
      // Same contract as ShellChrome's: the scroll listener only exists after
      // hydration, so before it the bar is simply always revealed (the safe state).
      // Surfaced so a browser test can wait for the real behavior rather than race
      // it.
      data-ready={ready ? "true" : "false"}
      // Full-bleed on a phone so the sticky bar's background covers the content
      // gutters as the page scrolls under it; from `sm` up it is an ordinary block
      // in the reading column with no background of its own.
      className="sub-chrome sticky top-[var(--shell-chrome-h)] z-20 -mx-4 mb-3 border-b border-black/10 bg-white/85 px-4 backdrop-blur-xl sm:static sm:z-auto sm:mx-0 sm:mb-6 sm:border-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none dark:border-white/10 dark:bg-ink-950/85 sm:dark:bg-transparent"
    >
      <button
        type="button"
        data-testid="trends-context-toggle"
        aria-expanded={open}
        aria-controls="trends-context-controls"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 py-2 text-left text-sm font-medium text-slate-600 sm:hidden dark:text-slate-300"
      >
        <span data-testid="trends-context-label" className="truncate">
          {label}
        </span>
        <IconChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div
        id="trends-context-controls"
        data-testid="trends-context-controls"
        className={`${open ? "block pb-2" : "hidden"} sm:block sm:pb-0`}
      >
        {controls}
      </div>
    </div>
  );
}
