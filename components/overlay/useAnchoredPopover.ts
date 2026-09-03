"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  anchoredPosition,
  type AnchoredAlign,
  type AnchoredPosition,
} from "@/lib/anchored-position";

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
// coordinates. Until then the style below is a hidden one — never a panel
// briefly at 0,0.

export function useAnchoredPopover({
  open,
  anchorRef,
  align = "start",
  matchAnchorWidth = false,
  fallbackWidth = 0,
  preferredMaxHeight,
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
  // A cap the panel wants for its OWN sake, tighter than the room: a listbox that
  // should stop at eight rows on a tall screen rather than growing to fill it.
  // `pos.maxHeight` is reported either way and is never more than the room on the
  // side the panel landed — applying it is the consumer's job (#4776).
  preferredMaxHeight?: number;
  remeasureKey?: unknown;
}): {
  // THE WHOLE ANSWER, READY TO WEAR (#4887) — a style, not four numbers, because
  // the numbers are separable and the decision is not. `maxHeight` is required
  // (#4776) because a consumer applying only the coordinates is not opting out of
  // a bound, it does not know there was one, and its panel runs off the screen
  // edge. A style leaves nothing to drop, so the two hosts that portal an anchored
  // surface — AnchoredPanel's box and Combobox's listbox, which #4887 ruled stay
  // two — differ in what they put inside it and in nothing else.
  panelStyle: CSSProperties;
  // The style hides an unplaced panel already; a host that must not ACT on one —
  // moving focus in, which a browser refuses on a hidden element — asks here.
  measured: boolean;
  // Pass as the portaled panel's `ref`.
  attachPanel: (node: HTMLElement | null) => void;
  panelRef: React.RefObject<HTMLElement | null>;
} {
  const panelRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const panel = panelRef.current;
    setPos(
      anchoredPosition({
        anchor: r,
        panel: {
          height: panel?.offsetHeight ?? 0,
          width: panel?.offsetWidth ?? fallbackWidth,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        matchAnchorWidth,
        preferredMaxHeight,
      })
    );
  }, [anchorRef, align, matchAnchorWidth, fallbackWidth, preferredMaxHeight]);

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

  return {
    panelStyle: {
      position: "fixed",
      top: pos?.top ?? 0,
      left: pos?.left ?? 0,
      width: pos?.width,
      maxHeight: pos?.maxHeight,
      visibility: pos ? "visible" : "hidden",
    },
    measured: pos !== null,
    attachPanel,
    panelRef,
  };
}
