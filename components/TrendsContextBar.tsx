"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { revealShellChrome, useShellChrome } from "@/components/useShellChrome";

// Trends has two different controls: primary section navigation and a shared
// chart window. On a phone the old disclosure hid BOTH behind
// "Overview · 90D", making the tabs look like advanced filters. Keep the tabs
// permanently visible instead, with the active range as a fixed trigger at the
// right edge. Opening the range reveals only range controls beneath the stable
// tab row.
//
// The whole unit still rides the app shell: charts retain a visible window label
// while the chrome is shown, and tabs + range hide/reveal together on scroll.
// From `sm` up the range trigger disappears and the same range controls and tab
// strip return to their classic stacked desktop order.
export default function TrendsContextBar({
  rangeLabel,
  tabs,
  controls,
}: {
  rangeLabel: string;
  tabs: ReactNode;
  controls: ReactNode;
}) {
  const { hidden, ready } = useShellChrome();
  const [open, setOpen] = useState(false);
  const controlsId = "trends-context-controls";

  function toggleRangeControls() {
    const closing = open;
    setOpen((value) => !value);
    revealShellChrome();
    if (closing) {
      // Closing removes a tall in-flow panel. Browsers may clamp scrollY and emit
      // a scroll event from that layout shift; re-anchor after the new geometry
      // has painted so neither this row nor the app bar mistakes it for intent.
      requestAnimationFrame(() => requestAnimationFrame(revealShellChrome));
    }
  }

  return (
    <div
      data-testid="trends-context-bar"
      data-expanded={open ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
      className="sub-chrome sticky top-(--shell-chrome-h) z-20 -mx-4 -mt-4 mb-3 bg-white/85 backdrop-blur-xl sm:static sm:z-auto sm:mx-0 sm:mt-0 sm:mb-6 sm:bg-transparent sm:backdrop-blur-none dark:bg-ink-950/85 sm:dark:bg-transparent"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:flex sm:flex-col">
        <div className="min-w-0 sm:order-2 sm:**:[[role=tab]]:px-4 sm:**:[[role=tab]]:py-2 sm:**:[[role=tab]]:text-sm sm:**:[[role=tab]]:font-medium">
          {tabs}
        </div>

        <button
          type="button"
          data-testid="trends-context-toggle"
          aria-expanded={open}
          aria-controls={controlsId}
          aria-label={`Date range: ${rangeLabel}`}
          onClick={toggleRangeControls}
          className="-mb-px flex max-w-40 items-center gap-1 border-b border-l border-black/10 px-3 text-sm font-semibold text-slate-600 sm:hidden dark:border-white/10 dark:text-slate-300"
        >
          <span
            data-testid="trends-context-label"
            className="truncate"
            title={rangeLabel}
          >
            {rangeLabel === "All time" ? "All" : rangeLabel}
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
          className={`col-span-2 border-b border-black/10 px-4 pb-2 pt-2 sm:order-1 sm:block sm:border-0 sm:px-0 sm:pt-0 sm:pb-0 dark:border-white/10 ${
            open ? "block" : "hidden"
          }`}
        >
          {controls}
        </div>
      </div>
    </div>
  );
}
