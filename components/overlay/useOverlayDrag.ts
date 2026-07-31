"use client";

import { useCallback, useRef, useState } from "react";
import { OVERLAY_MOTION_MS } from "@/lib/motion";
import type { GestureDirection } from "@/lib/gesture";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";
import { useDragGesture } from "./useDragGesture";

// Drag-to-resolve for an overlay PANEL (issues #1425, #1469).
//
// The shared half of "swipe the panel away": the finger-following transform, the
// release settle, and the handshake that keeps an inline transform from fighting
// a CSS keyframe. What the drag MEANS is the caller's `onOutcome` — BottomSheet
// passes its `onClose` (dismiss/discard), the activity dock passes its
// `onMinimize` (collapse to the bar, session still running). Neither surface
// implements a gesture; both consume this one.
//
// ── The keyframe/inline-transform handshake ──────────────────────────────────
//
// A panel is animated by a CSS class (`overlayMotionClass`) and dragged by an
// inline `style.transform`. A running CSS animation OUTRANKS inline style, so if
// both are live the drag silently does nothing and the panel snaps back. The fix
// is a one-way latch: the moment a drag claims the panel this hook reports
// `suppressMotion`, the consumer stops emitting the keyframe class for the rest
// of that mount, and from then on the panel's transform is ours alone —
// including its exit, which we run as an inline transition instead. The latch
// never releases while mounted: re-adding the enter class after a cancelled drag
// would replay the whole slide-up on a panel that is already sitting still.
//
// ── Reduced motion ───────────────────────────────────────────────────────────
//
// The gesture still WORKS — the preference is about travel, not about taking
// away an interaction. It simply stops following the finger: nothing moves until
// the release, and a committing release resolves instantly (#794 8d / #1416 F).

export interface OverlayDragOptions {
  // The element that MOVES.
  panelRef: React.RefObject<HTMLElement | null>;
  // Where the gesture may START. Defaults to the whole panel — right for the
  // drawer, whose swipe-left has no scrollable rival on its axis.
  //
  // A bottom-anchored panel passes its DRAG HANDLE instead, and that is a safety
  // decision, not an ergonomic one: the sheet's body scrolls and holds real
  // controls, so a panel-wide grab would make "drag down over a button" a
  // dismissal and put the gesture in a race with the scroller. The handle is the
  // affordance that already says "flick me away", it owns its axis outright
  // (`touch-none`), and nothing inside it can be hit by accident.
  grabRef?: React.RefObject<HTMLElement | null>;
  // Which way the panel leaves: "down" for a bottom-anchored sheet or dock,
  // "left" for the edge-anchored drawer.
  direction: Extract<GestureDirection, "down" | "left">;
  // THE OUTCOME — dismiss, minimize, whatever this surface's contract says.
  onOutcome: () => void;
  // What happens to the PANEL when the outcome fires, which follows from the
  // surface's lifecycle rather than from the gesture:
  //
  //   * "away" (default) — the panel is going away. Finish the travel it started
  //     (an inline transition for one duration) while the consumer unmounts it.
  //     The sheet and the drawer are both this.
  //   * "rest" — the panel is being PARKED, not destroyed. The activity dock
  //     minimizes: the same element stays mounted with a live workout inside it
  //     and is merely hidden, so it must return to its resting transform at
  //     once. Animating it "away" would be animating something the consumer has
  //     already made `display: none`, and leaving the transform behind would
  //     restore the panel translated off the bottom of the screen.
  commitSettle?: "away" | "rest";
  enabled?: boolean;
}

export function useOverlayDrag({
  panelRef,
  grabRef,
  direction,
  onOutcome,
  commitSettle = "away",
  enabled = true,
}: OverlayDragOptions): { suppressMotion: boolean } {
  const reduceMotion = usePrefersReducedMotion();
  const [suppressMotion, setSuppressMotion] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Where "gone" is, in px along the drag axis: the panel's own extent, so a
  // dismissed sheet clears the bottom edge and a dismissed drawer clears the
  // left one no matter how tall/wide its content made it.
  const goneOffset = useCallback((): number => {
    const el = panelRef.current;
    if (!el) return 0;
    return direction === "down" ? el.offsetHeight : -el.offsetWidth;
  }, [direction, panelRef]);

  const write = useCallback(
    (px: number) => {
      const el = panelRef.current;
      if (!el) return;
      el.style.transform =
        direction === "down" ? `translateY(${px}px)` : `translateX(${px}px)`;
    },
    [direction, panelRef]
  );

  const settle = useCallback(
    (to: number, after?: () => void) => {
      const el = panelRef.current;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      if (!el || reduceMotion) {
        if (el) el.style.transform = "";
        after?.();
        return;
      }
      el.classList.add("overlay-settle");
      write(to);
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        const node = panelRef.current;
        if (!node) return;
        node.classList.remove("overlay-settle");
        // Only a settle BACK TO REST clears the transform; a settle that sent
        // the panel away leaves it away until the consumer unmounts it.
        if (to === 0) node.style.transform = "";
      }, OVERLAY_MOTION_MS);
      after?.();
    },
    [panelRef, reduceMotion, write]
  );

  useDragGesture({
    targetRef: grabRef ?? panelRef,
    direction,
    enabled,
    onStart: () => setSuppressMotion(true),
    // Under reduced motion the panel does not travel with the finger. The
    // gesture is still recognized and still resolves on release.
    onFollow: reduceMotion
      ? undefined
      : (px) => {
          // Rubber-band nothing: the panel tracks 1:1 in the committing
          // direction and refuses to move the other way (lib/gesture.ts clamps
          // travel at 0), so it can never be dragged past its resting edge.
          write(px);
        },
    onCommit: () => {
      if (commitSettle === "rest") {
        // Parked, not destroyed: drop the transform now and hand the panel back
        // to the stylesheet, because the consumer is about to hide (not unmount)
        // this exact element and will show it again unchanged.
        const el = panelRef.current;
        if (el) {
          el.classList.remove("overlay-settle");
          el.style.transform = "";
        }
        setSuppressMotion(false);
        onOutcome();
        return;
      }
      settle(goneOffset(), onOutcome);
    },
    onCancel: () => settle(0),
  });

  return { suppressMotion };
}
