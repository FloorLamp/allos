"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
// `suppressMotion`, the consumer stops emitting the keyframe class, and from
// then on the panel's transform is ours alone — including its exit, which we run
// as an inline transition instead. It never releases while that panel is alive:
// re-adding the enter class after a cancelled drag would replay the whole
// slide-up on a panel that is already sitting still.
//
// THE LATCH'S SCOPE IS THE PANEL, NOT THE COMPONENT (#2725). The rationale above
// is a claim about one DOM element — the one carrying the inline transform — and
// it expires the moment that element is gone. `usePresence` unmounts the panel
// between opens, so a remounted panel has no transform to fight and is owed its
// enter animation. Scoping the latch to the component instead was invisible only
// while every consumer unmounted with its panel: the quick-log sheet's
// `BottomSheet` is rendered unconditionally by `MobileNav` and the quick-entry
// host retains its form after close, so those instances never unmount and ONE
// cancelled 30px drag muted that sheet's animations — every later open snapping
// in, every later close ending in a dark hold — for the page's whole life.
// Consumers whose panel unmounts pass `panelMounted`; see the option below.
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
  // "left" for the edge-anchored drawer, "up" for the top-anchored profile
  // switcher (#1801), which retreats back through the bar it dropped from.
  direction: Extract<GestureDirection, "down" | "left" | "up">;
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
  // Is the PANEL element currently in the DOM? The `suppressMotion` latch is
  // released when this goes false, because that is when the transform it was
  // protecting ceases to exist (see the handshake note above).
  //
  // Pass the consumer's `usePresence` `mounted` — the same flag that decides
  // whether the panel renders at all, so the latch cannot outlive it. The
  // default is `true`: a surface whose panel is PARKED rather than unmounted
  // (the activity dock hides its element to keep a live workout running) has no
  // unmount to key on, and clears the latch on commit instead.
  panelMounted?: boolean;
  enabled?: boolean;
}

export function useOverlayDrag({
  panelRef,
  grabRef,
  direction,
  onOutcome,
  commitSettle = "away",
  panelMounted = true,
  enabled = true,
}: OverlayDragOptions): { suppressMotion: boolean } {
  const reduceMotion = usePrefersReducedMotion();
  const [suppressMotion, setSuppressMotion] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The panel is gone; so is anything the latch was protecting. Releasing here
  // rather than on close is deliberate — during the exit the element is still on
  // screen carrying the drag's inline transform, and re-admitting the exit
  // keyframe over it is the very fight the latch exists to prevent.
  useEffect(() => {
    if (panelMounted) return;
    setSuppressMotion(false);
  }, [panelMounted]);

  // Everything below speaks the recognizer's language: DIRECTED travel, always
  // >= 0 (lib/gesture.ts clamps movement the other way at 0). The axis and the
  // sign that turn that scalar into a transform live in exactly one place —
  // here — so adding the top-anchored panel (#1801) was a row in this table
  // rather than a second signing convention in the consumer.
  const axis = direction === "left" ? "X" : "Y";
  const sign = direction === "down" ? 1 : -1;

  // How far "gone" is along that axis: the panel's own extent, so a dismissed
  // sheet clears the bottom edge, a dismissed drawer the left one, and a
  // dismissed top panel the top one, no matter how tall/wide its content is.
  const goneOffset = useCallback((): number => {
    const el = panelRef.current;
    if (!el) return 0;
    return axis === "X" ? el.offsetWidth : el.offsetHeight;
  }, [axis, panelRef]);

  const write = useCallback(
    (travelPx: number) => {
      const el = panelRef.current;
      if (!el) return;
      el.style.transform = `translate${axis}(${sign * travelPx}px)`;
    },
    [axis, sign, panelRef]
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
