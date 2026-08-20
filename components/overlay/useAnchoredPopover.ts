"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// ANCHORED POPOVER POSITIONING — the one place a portaled panel is placed
// against the control that opened it (issue #3271).
//
// WHY A PORTAL AT ALL. An absolutely-positioned panel is clipped by any ancestor
// carrying an `overflow`, and `z-index` does not help: z-index does not escape a
// clip box. An `overflow` establishes that box whether or not it is currently
// scrolling. So a panel left in flow is confined to whichever ancestor scroller
// it happens to sit in — a phone sheet bounded at `max-h-[85dvh]`, a table's
// horizontal scroller, a `max-h` editor. Portaling to <body> and positioning
// `fixed` from the anchor's viewport rect is what removes the clip; everything
// below is the bookkeeping that costs.
//
// WHY IT IS SHARED. This was written twice before it was written here —
// OverflowMenu's menu and DateField's calendar — and the two copies had already
// drifted: only one of them tracked layout shift. The combobox listbox was about
// to be the third. Consolidation at the point of the third use, not
// speculatively: the two existing copies both moved onto this, so there is one
// implementation to fix.
//
// WHAT MUST BE TRACKED, each one learned from a real sighting:
//
//   * SCROLL IN ANY ANCESTOR — hence a CAPTURE-phase listener on window. A
//     scroll event on an inner scroller does not bubble, so a bubble-phase
//     window listener never hears the one scroller that actually moved the
//     anchor.
//   * RESIZE — the viewport changing under a fixed panel.
//   * LAYOUT SHIFT, which fires neither of those (#2839). Content growing ABOVE
//     the anchor — a lazily-loaded chart bundle mounting was the sighting — moves
//     the anchor with no scroll and no resize, leaving the panel floating where
//     the anchor used to be. Document height is a proxy that covers exactly that
//     class, and ResizeObserver fires only on an actual size change, so this
//     stays quiet while the page is still.
//
// The panel is measured through a REF CALLBACK rather than an effect: the portal
// node entering the DOM is the event that makes measurement possible, and
// measuring there places the panel before it is ever painted at the wrong
// coordinates. Until the first measurement `pos` is null, which a consumer
// renders as `visibility: hidden` — never as a panel briefly at 0,0.

const GAP = 4; // matches mt-1
const MARGIN = 8; // keep the panel this far from the viewport edges

export type AnchoredAlign = "start" | "end";

export interface AnchoredPosition {
  top: number;
  left: number;
  // Present only when the consumer asked to match the anchor's width.
  width?: number;
}

export function useAnchoredPopover({
  open,
  anchorRef,
  align = "start",
  matchAnchorWidth = false,
  fallbackWidth = 0,
  // Re-anchor when a consumer's own state changes the panel's size while it
  // stays open (a menu expanding into a wider picker).
  remeasureKey,
}: {
  open: boolean;
  // The element the panel is placed against — the field, or the trigger.
  anchorRef: React.RefObject<HTMLElement | null>;
  // Which edges line up: `start` puts the panel's left edge on the anchor's
  // left, `end` puts its right edge on the anchor's right.
  align?: AnchoredAlign;
  // The panel takes the anchor's width — a field's dropdown, which reads as part
  // of the field rather than as a floating menu.
  matchAnchorWidth?: boolean;
  // Used for the viewport clamp before the panel has been measured, so the first
  // paint of a known-width panel is already in the right place.
  fallbackWidth?: number;
  remeasureKey?: unknown;
}): {
  pos: AnchoredPosition | null;
  // Pass as the portaled panel's `ref`.
  attachPanel: (node: HTMLElement | null) => void;
  reposition: () => void;
  panelRef: React.RefObject<HTMLElement | null>;
} {
  const panelRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const panel = panelRef.current;
    const height = panel?.offsetHeight ?? 0;
    const width = matchAnchorWidth
      ? r.width
      : (panel?.offsetWidth ?? fallbackWidth);

    // Below the anchor by default; flip above only when it will not fit below
    // AND there is genuinely more room up top — a flip into an even smaller gap
    // trades one clipped panel for another.
    let top = r.bottom + GAP;
    if (
      top + height > window.innerHeight - MARGIN &&
      r.top - GAP - height > MARGIN
    )
      top = r.top - GAP - height;

    let left = align === "end" ? r.right - width : r.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

    setPos(matchAnchorWidth ? { top, left, width } : { top, left });
  }, [anchorRef, align, matchAnchorWidth, fallbackWidth]);

  // Attach measures; DETACH forgets. Clearing here rather than in an effect ties
  // the reset to the event that actually ends an episode — the panel leaving the
  // DOM — so the next open starts unmeasured (and therefore hidden) instead of
  // painting one frame where the anchor used to be.
  const attachPanel = useCallback(
    (node: HTMLElement | null) => {
      panelRef.current = node;
      if (node) reposition();
      else setPos(null);
    },
    [reposition]
  );

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const ro = new ResizeObserver(reposition);
    ro.observe(document.documentElement);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      ro.disconnect();
    };
  }, [open, reposition, remeasureKey]);

  return { pos, attachPanel, reposition, panelRef };
}
