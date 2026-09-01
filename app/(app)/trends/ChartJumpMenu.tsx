"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import Button from "@/components/Button";

// Compact chart navigator for Trends → Overview → body census full-chart layout. The former
// sticky chip row looked like a third tab level and spent horizontal/vertical
// space on every chart name. This keeps the same present-only anchor vocabulary
// behind one inline dropdown beside the layout toggle.
//
// THE PANEL IS THE SHARED HOST NOW (#3374). This was the last hand-rolled
// anchored menu outside components/overlay/AnchoredPanel.tsx: an `absolute
// top-full` panel, which any `overflow` ancestor clips and no z-index rescues,
// and which stayed a desktop dropdown on a phone. Adopting the host buys the
// portal, the viewport clamp, the flip-above, and — the point of the exercise —
// the bottom sheet below `md`. What stays here is what is genuinely this menu's:
// the roving focus, the arrow/Home/End keys, and which chart is current.
// The clamp width before the panel has been measured, so its first paint is
// already in the right place. Matches `min-w-44`.
const MENU_WIDTH = 176;

// One present-only chart anchor. It used to be declared by the sticky chip row
// this menu replaced; that row was deleted in #4515, its last two importers
// having been `import type` lines for exactly this interface, so it lives with
// the only component that renders a chart anchor.
export interface ChartChip {
  id: string;
  label: string;
}

export default function ChartJumpMenu({ items }: { items: ChartChip[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const focusOnOpenIndexRef = useRef(0);
  const menuNavigationSinceOpenRef = useRef(false);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === active)
  );
  const activeLabel =
    items.find((item) => item.id === active)?.label ??
    items[0]?.label ??
    "Charts";

  useEffect(() => {
    const elements = items
      .map((item) => document.getElementById(item.id))
      .filter((element): element is HTMLElement => element != null);
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) =>
              left.boundingClientRect.top - right.boundingClientRect.top
          );
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -75% 0px" }
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [items]);

  // The option that was ACTIVE when the person opened the menu takes focus, in
  // either presentation. Snapshotting that index at open is deliberate: the
  // observer keeps changing `active` as charts cross the viewport, but a scroll
  // must not move keyboard focus inside an already-open menu.
  // The desktop host first mounts the portal hidden while it measures. Move
  // focus on the next frame, after those option refs attach and the panel has
  // its anchored position. The sheet follows the same path after its trap has
  // chosen an initial target.
  useEffect(() => {
    if (!open) return;
    const index = focusOnOpenIndexRef.current;
    const frame = requestAnimationFrame(() => {
      if (menuNavigationSinceOpenRef.current) return;
      // The host owns these two open-time positions. Anything else is a move the
      // person already made, so this deferred focus must yield to it (#4037).
      if (
        document.activeElement !== triggerRef.current &&
        document.activeElement !== optionRefs.current[0]
      )
        return;
      optionRefs.current[index]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (items.length === 0) return null;

  // Closing returns focus to the trigger. The popover never took focus off the
  // page's own flow, so it has to be put back by hand; the sheet's trap would
  // restore it anyway, and doing it here costs nothing and keeps ONE close path.
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = () => {
    focusOnOpenIndexRef.current = activeIndex;
    menuNavigationSinceOpenRef.current = false;
    setOpen(true);
  };

  const moveFocus = (direction: 1 | -1) => {
    // Claim focus even when wrapping lands on the same option. The deferred
    // open callback must not infer intent from whether activeElement changed.
    menuNavigationSinceOpenRef.current = true;
    const focusedIndex = optionRefs.current.findIndex(
      (option) => option === document.activeElement
    );
    const start = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const next = (start + direction + items.length) % items.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <nav
      aria-label="Jump to chart"
      data-testid="chart-jump-menu"
      className="relative z-50 flex items-center"
    >
      <div className="relative grid min-w-24 items-center">
        <Button
          ref={triggerRef}
          type="button"
          data-testid="chart-jump-menu-trigger"
          aria-label={`Jump to chart: ${activeLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (open) setOpen(false);
            else openMenu();
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            if (!open) {
              openMenu();
              return;
            }
            moveFocus(event.key === "ArrowDown" ? 1 : -1);
          }}
        >
          <span>{activeLabel}</span>
          <IconChevronDown
            aria-hidden="true"
            className={`h-4 w-4 text-slate-400 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </Button>

        <AnchoredPanel
          open={open}
          onClose={close}
          anchorRef={triggerRef}
          title="Jump to chart"
          role="menu"
          panelId={menuId}
          testId="chart-jump-menu-options"
          sheetTestId="chart-jump-menu-sheet"
          fallbackWidth={MENU_WIDTH}
          panelClassName="min-w-44 py-1"
          onPanelKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              menuNavigationSinceOpenRef.current = true;
              optionRefs.current[0]?.focus();
            } else if (event.key === "End") {
              event.preventDefault();
              menuNavigationSinceOpenRef.current = true;
              optionRefs.current[items.length - 1]?.focus();
            }
          }}
        >
          {() =>
            items.map((item, index) => {
              const selected = item.id === active;
              return (
                <a
                  key={item.id}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  href={`#${item.id}`}
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`chart-jump-${item.id}`}
                  onClick={() => {
                    setActive(item.id);
                    close();
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 px-3 text-left text-sm transition ${
                    selected
                      ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                  }`}
                >
                  <span>{item.label}</span>
                  {selected && (
                    <IconCheck aria-hidden="true" className="h-4 w-4" />
                  )}
                </a>
              );
            })
          }
        </AnchoredPanel>
      </div>
    </nav>
  );
}
