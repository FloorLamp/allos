"use client";

import { useEffect, useRef } from "react";
import {
  GESTURE_THRESHOLDS,
  axisOf,
  directedTravel,
  directedVelocity,
  isEdgeStart,
  lockedAxis,
  shouldCommit,
  type GestureDirection,
  type GesturePoint,
} from "@/lib/gesture";

// The ONE gesture recognizer (issues #1425, #1469).
//
// "Same gesture, divergent outcome, one recognizer": swipe-down on the sheet
// DISCARDS it, the same swipe-down on the activity dock MINIMIZES it, swipe-left
// closes the drawer, swipe-left/right on the Timeline walks to the adjacent day.
// Four contracts, one detector — the outcome is `onCommit`, the consumer's single
// callback, and it is the only thing that differs. That is the #1428 decision
// rule expressed in code: the dock never becomes discardable because nobody
// passes it a discarding `onCommit`, not because it recognizes a different swipe.
//
// The decisions themselves (axis lock, directed travel, distance-or-flick) are
// the pure lib/gesture.ts; this file owns only the DOM: which pointer, which
// element, and when to stop listening.
//
// ── Why the listeners live on `document` ─────────────────────────────────────
//
// The obvious shape — attach the start listener to `targetRef.current` in an
// effect — races the ref: on the render that mounts a panel the ref is still
// null, and refs are not reactive so the effect never re-runs. Listening at the
// document and testing CONTAINMENT at touch-start time (when the ref is
// certainly populated) makes the subscription stable and the check exact. It
// also means a drag that leaves the panel mid-gesture keeps tracking, which is
// what a finger flicking off the bottom of the screen actually does.
//
// ── Why TOUCH events and not Pointer Events ──────────────────────────────────
//
// Pointer Events are the tidier API and they are the WRONG stream for this, for
// a reason worth writing down because it cost a debugging session:
//
//   Chromium fires `pointercancel` — and stops sending `pointermove` — the
//   moment its own touch-scroll recognizer takes over the gesture. On a page
//   with the default `touch-action`, that happens after ONE move sample, on a
//   purely HORIZONTAL drag, because the page is scrollable and the browser has
//   not yet ruled a scroll out.
//
// So a pointer-based recognizer receives `pointerdown, pointermove, pointercancel`
// and never gets to decide anything — every page-level swipe silently does
// nothing, on a real Android phone exactly as in a test. Touch events keep
// flowing throughout (they are how the app's overscroll pull-to-refresh works
// too), which lets the AXIS LOCK in lib/gesture.ts do the arbitration on our
// side: a drag that turns out to be vertical is abandoned by us, having never
// interfered with the scroll the browser was already performing.
//
// ── Why nothing here calls preventDefault ────────────────────────────────────
//
// Every listener is passive, so a gesture we are still thinking about can never
// block scrolling: vertical scroll wins by DEFAULT and we simply decline to act.
// A surface that genuinely must own an axis says so declaratively in CSS
// (`touch-action`) — see components/overlay/tokens.ts's drag-handle token, the
// one place in the app that takes an axis away from the browser, on a 40x24px
// handle that has nothing to scroll.
//
// A consequence, and an accepted one: these are touch gestures only. A mouse
// drag never triggers them, which is right — the tap/click affordance beside
// every gesture is the pointer route, and a mouse drag across a page is a text
// selection.

export interface DragGestureOptions {
  // The element the gesture must START inside. Omitted ⇒ anywhere in the
  // document (the drawer's edge swipe, which has no element to start on because
  // the drawer is not mounted yet).
  targetRef?: React.RefObject<HTMLElement | null>;
  // The direction that commits. Travel the other way is not negative travel — it
  // is no travel (see lib/gesture.ts).
  direction: GestureDirection;
  enabled?: boolean;
  // Require the gesture to start within `edgePx` of the left screen edge.
  requireEdgeStart?: boolean;
  // The inverse, and it exists because two gestures share the rightward swipe:
  // the drawer opens on one that STARTS at the left edge, and the Timeline walks
  // to the previous day on one that starts anywhere. Without this a rightward
  // swipe beginning in that first 28px would fire both, and the user would land
  // on yesterday with the navigation drawer open over it.
  ignoreEdgeStart?: boolean;
  // Stand down when the gesture starts inside something that scrolls on the same
  // axis — a wide table, a chart strip. The inner scroller's own scrolling is
  // always the better reading of a horizontal drag that starts inside it.
  ignoreSameAxisScrollers?: boolean;
  // Fires once, when the gesture claims its axis in the committing direction.
  // The consumer suppresses its enter/exit keyframe here so an inline transform
  // and a running animation never fight over the same property.
  onStart?: () => void;
  // Per-frame travel in px (>= 0) while the gesture is claimed. Omit for a
  // discrete swipe (the Timeline) or under reduced motion, where the surface
  // should not follow the finger at all — it snaps at the threshold instead.
  onFollow?: (travelPx: number) => void;
  // THE OUTCOME. Dismiss, minimize, navigate — the consumer decides.
  onCommit: () => void;
  // Released without committing, or the browser took the gesture for a scroll.
  onCancel?: () => void;
}

interface ActiveGesture {
  // The browser's id for the finger we are following, so a second finger landing
  // mid-gesture can never be mistaken for it.
  touchId: number;
  from: GesturePoint;
  claimed: boolean;
  // Set once the axis resolves the WRONG way (a vertical scroll on a horizontal
  // surface). The gesture is then dead for good — a finger that starts scrolling
  // and curls sideways must not suddenly navigate.
  abandoned: boolean;
}

function pointOf(touch: Touch, t: number): GesturePoint {
  return { x: touch.clientX, y: touch.clientY, t };
}

// The finger we are following, in this event's list — `touches` while it is down,
// `changedTouches` on the event that lifts it.
function trackedTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

// Walk from the gesture's origin up to (and excluding) `root`, looking for an
// ancestor that actually scrolls on `axis`.
function insideSameAxisScroller(
  origin: Element | null,
  root: Element | null,
  axis: "x" | "y"
): boolean {
  let node: Element | null = origin;
  while (node && node !== root) {
    const style = getComputedStyle(node);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      const scrollSize = axis === "x" ? node.scrollWidth : node.scrollHeight;
      const clientSize = axis === "x" ? node.clientWidth : node.clientHeight;
      if (scrollSize > clientSize + 1) return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function useDragGesture(options: DragGestureOptions): void {
  // Options change every render (fresh closures); the listeners must not. One
  // ref, read at event time, keeps the subscription stable for the life of the
  // surface.
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<ActiveGesture | null>(null);

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    const finish = (commit: boolean, to: GesturePoint | null) => {
      const gesture = active.current;
      active.current = null;
      if (!gesture || !gesture.claimed) return;
      const o = latest.current;
      if (!commit || !to) {
        o.onCancel?.();
        return;
      }
      const travel = directedTravel(gesture.from, to, o.direction);
      const velocity = directedVelocity(gesture.from, to, o.direction);
      // The outcome runs AFTER the browser finishes dispatching this touch
      // sequence, never inside it. Two things depend on that:
      //
      //   * A page can carry more than one recognizer on the same gesture (the
      //     Timeline arms a left AND a right one, and the drawer's edge swipe
      //     listens alongside them). Firing an outcome synchronously would run a
      //     navigation — or an unmount — while the OTHER recognizers' handlers
      //     for the same `touchend` are still queued, against a DOM that is
      //     already going away.
      //   * A client navigation started inside the touch dispatch was observed
      //     to be silently dropped: the router's transition begins while the
      //     browser is still settling the gesture and never commits, so the
      //     swipe appears to do nothing at all. Deferring by a task makes it
      //     land every time.
      if (shouldCommit(travel, velocity)) setTimeout(o.onCommit, 0);
      else if (o.onCancel) setTimeout(o.onCancel, 0);
    };

    const onStart = (e: TouchEvent) => {
      const o = latest.current;
      // One finger at a time. A second touch during a drag (a pinch, the other
      // thumb landing) leaves the first gesture alone rather than re-anchoring
      // it, and a gesture that BEGINS as a two-finger touch is not ours at all.
      if (active.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (o.requireEdgeStart && !isEdgeStart(touch.clientX)) return;
      if (o.ignoreEdgeStart && isEdgeStart(touch.clientX)) return;

      const root = o.targetRef?.current ?? null;
      if (o.targetRef) {
        const origin = e.target;
        if (!root || !(origin instanceof Node) || !root.contains(origin))
          return;
      }
      if (
        o.ignoreSameAxisScrollers &&
        e.target instanceof Element &&
        insideSameAxisScroller(e.target, root, axisOf(o.direction))
      ) {
        return;
      }
      active.current = {
        touchId: touch.identifier,
        from: pointOf(touch, e.timeStamp),
        claimed: false,
        abandoned: false,
      };
    };

    const onMove = (e: TouchEvent) => {
      const gesture = active.current;
      if (!gesture || gesture.abandoned) return;
      const touch = trackedTouch(e.touches, gesture.touchId);
      if (!touch) return;
      const o = latest.current;
      const to = pointOf(touch, e.timeStamp);

      if (!gesture.claimed) {
        const axis = lockedAxis(gesture.from, to);
        if (!axis) return; // still undecided — and we have blocked nothing
        if (axis !== axisOf(o.direction)) {
          // The other axis won: the browser is already scrolling, and this
          // gesture is dead for good. A finger that starts scrolling and curls
          // sideways must not suddenly navigate.
          gesture.abandoned = true;
          return;
        }
        // Right axis, but is it the right WAY along it? A drag that goes up on a
        // "down" surface is a scroll-up, not a dismissal.
        if (
          directedTravel(gesture.from, to, o.direction) <
          GESTURE_THRESHOLDS.axisLockPx
        ) {
          gesture.abandoned = true;
          return;
        }
        gesture.claimed = true;
        o.onStart?.();
      }
      o.onFollow?.(directedTravel(gesture.from, to, o.direction));
    };

    const onEnd = (e: TouchEvent) => {
      const gesture = active.current;
      if (!gesture) return;
      const touch = trackedTouch(e.changedTouches, gesture.touchId);
      if (!touch) return;
      finish(true, pointOf(touch, e.timeStamp));
    };

    // The system took the touch (a call arrived, the page was backgrounded, an
    // edge gesture won). Stand down and settle back.
    const onCancel = (e: TouchEvent) => {
      const gesture = active.current;
      if (!gesture) return;
      if (!trackedTouch(e.changedTouches, gesture.touchId)) return;
      finish(false, null);
    };

    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    document.addEventListener("touchcancel", onCancel, opts);
    return () => {
      document.removeEventListener("touchstart", onStart, opts);
      document.removeEventListener("touchmove", onMove, opts);
      document.removeEventListener("touchend", onEnd, opts);
      document.removeEventListener("touchcancel", onCancel, opts);
      active.current = null;
    };
  }, [enabled]);
}
