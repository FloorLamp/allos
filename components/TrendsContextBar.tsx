"use client";

import { type ReactNode } from "react";
import ContextBar from "@/components/ContextBar";
import { useShellChrome } from "@/components/useShellChrome";

// The Trends hub's phone chrome (issue #1485 F): the range pills and the tab strip
// collapse into ONE line — "Overview · 90D ▾" — that expands to the full controls
// on tap.
//
// The collapse itself lives in components/ContextBar.tsx (shared with the Timeline's
// filter bar since #1517); this file is the Trends PLACEMENT — the invariant it
// exists to hold is that no chart on this page is ever rendered without its window
// named, which is why the bar is sticky rather than merely collapsible.
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
  const { hidden, ready } = useShellChrome();
  return (
    <ContextBar
      idPrefix="trends-context"
      label={label}
      controls={controls}
      rootProps={{
        "data-hidden": hidden ? "true" : "false",
        // Same contract as ShellChrome's: the scroll listener only exists after
        // hydration, so before it the bar is simply always revealed (the safe
        // state). Surfaced so a browser test can wait for the real behavior rather
        // than race it.
        "data-ready": ready ? "true" : "false",
      }}
      // Full-bleed on a phone so the sticky bar's background covers the content
      // gutters as the page scrolls under it; from `sm` up it is an ordinary block
      // in the reading column with no background of its own.
      className="sub-chrome sticky top-[var(--shell-chrome-h)] z-20 -mx-4 mb-3 border-b border-black/10 bg-white/85 px-4 backdrop-blur-xl sm:static sm:z-auto sm:mx-0 sm:mb-6 sm:border-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none dark:border-white/10 dark:bg-ink-950/85 sm:dark:bg-transparent"
    />
  );
}
