// Touch-gesture recognition — the PURE half (issues #1425, #1469).
//
// Every drag/swipe in the app answers the same three questions, and getting any
// of them wrong is what makes hand-rolled gesture code feel broken:
//
//   1. WHICH AXIS is this? A finger never moves in a straight line, so the first
//      few pixels are noise. Claiming an axis too early steals the page's
//      vertical scroll; claiming it too late makes the gesture feel dead.
//   2. HOW FAR has it travelled IN THE DIRECTION THAT MATTERS? A sheet you drag
//      down 40px and then back up is not a dismissal, and dragging a
//      bottom-anchored sheet UPWARD past its resting edge is not a thing.
//   3. SHOULD IT COMMIT on release? Distance alone punishes a fast flick (which
//      covers little distance before the finger leaves); velocity alone fires on
//      a twitch. It is distance OR flick, never one of them.
//
// This module owns those three answers for EVERY gesture surface, and nothing
// here touches the DOM: it takes points and returns decisions, so the whole
// contract is testable with fixture traces (lib/__tests__/gesture.test.ts).
// components/overlay/useDragGesture.ts is the ONE React recognizer over it, and
// the source-scan guard (lib/__tests__/overlay-motion-chokepoint.test.ts) is what
// keeps the next gesture from hand-rolling a second detector.
//
// The sibling module is lib/pull-to-refresh.ts (#1467): overscroll pull is a
// different question — it is about the SCROLL POSITION at the start, not about
// axis arbitration on an element — so it keeps its own classifier. That is a
// deliberate split, recorded in the guard's allowlist.

export interface GesturePoint {
  x: number;
  y: number;
  // Milliseconds from any consistent origin (`event.timeStamp` /
  // `performance.now()`). Only differences are ever used.
  t: number;
}

export type GestureAxis = "x" | "y";
export type GestureDirection = "left" | "right" | "up" | "down";

export interface GestureThresholds {
  // Total travel before an axis can be claimed at all. Below this the gesture is
  // still "undecided" and the browser keeps whatever it was going to do.
  axisLockPx: number;
  // The dominant axis must out-travel the other by this factor to be claimed.
  // 1.0 would claim on a 45° diagonal — where the user's intent is genuinely
  // ambiguous and the SAFE reading is "they are scrolling".
  axisRatio: number;
  // Travel that commits the gesture on release, regardless of speed.
  commitPx: number;
  // Speed (px/ms) that commits on release regardless of distance — the flick.
  flickPxPerMs: number;
  // How close to the screen edge a gesture must START to count as an edge swipe
  // (the drawer's open gesture). Kept generous: a thumb arriving from off-screen
  // lands its first sampled point a surprising distance in.
  edgePx: number;
}

// One set of numbers for every surface, so the sheet, the drawer, the dock and
// the Timeline all agree on what "a swipe" is. Tuned for a 390px-wide phone:
// `commitPx` is ~16% of the width (a deliberate push, not a twitch) and
// `flickPxPerMs` is about half of a comfortable flick's peak speed.
export const GESTURE_THRESHOLDS: GestureThresholds = {
  axisLockPx: 10,
  axisRatio: 1.4,
  commitPx: 64,
  flickPxPerMs: 0.45,
  edgePx: 28,
};

// The axis a gesture has committed to, or null while it is still undecided.
// Returns null forever if the finger never travels `axisLockPx` — a tap, a
// long-press, a jitter.
export function lockedAxis(
  from: GesturePoint,
  to: GesturePoint,
  thresholds: GestureThresholds = GESTURE_THRESHOLDS
): GestureAxis | null {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (Math.max(dx, dy) < thresholds.axisLockPx) return null;
  if (dx >= dy * thresholds.axisRatio) return "x";
  if (dy >= dx * thresholds.axisRatio) return "y";
  // Diagonal: ambiguous, and an ambiguous gesture is a scroll.
  return null;
}

export function axisOf(direction: GestureDirection): GestureAxis {
  return direction === "left" || direction === "right" ? "x" : "y";
}

// Travel toward `direction`, in pixels, clamped at 0. Movement the OTHER way is
// not negative travel — it is simply no travel, which is what keeps a
// bottom-anchored sheet from being dragged up off its resting edge and a
// left-anchored drawer from being dragged past its own width.
export function directedTravel(
  from: GesturePoint,
  to: GesturePoint,
  direction: GestureDirection
): number {
  const raw =
    direction === "left"
      ? from.x - to.x
      : direction === "right"
        ? to.x - from.x
        : direction === "up"
          ? from.y - to.y
          : to.y - from.y;
  return Math.max(0, raw);
}

// Speed toward `direction` in px/ms over the whole gesture. Zero for a
// zero-duration sample (two events sharing a timestamp) rather than Infinity —
// an unmeasurable speed must never be read as an infinitely fast flick.
export function directedVelocity(
  from: GesturePoint,
  to: GesturePoint,
  direction: GestureDirection
): number {
  const dt = to.t - from.t;
  if (!(dt > 0)) return 0;
  return directedTravel(from, to, direction) / dt;
}

// The release decision: far enough OR fast enough.
export function shouldCommit(
  travelPx: number,
  velocityPxPerMs: number,
  thresholds: GestureThresholds = GESTURE_THRESHOLDS
): boolean {
  if (travelPx >= thresholds.commitPx) return true;
  // A flick still has to be a real gesture, not a tap that wobbled: it must have
  // cleared the axis lock before its speed counts for anything.
  return (
    velocityPxPerMs >= thresholds.flickPxPerMs &&
    travelPx >= thresholds.axisLockPx
  );
}

// Did this gesture start at the left screen edge? The drawer's open gesture is
// the only edge swipe in the app, and it is deliberately narrow: a swipe that
// starts mid-page is a page gesture, not a shell gesture.
export function isEdgeStart(
  x: number,
  thresholds: GestureThresholds = GESTURE_THRESHOLDS
): boolean {
  return x <= thresholds.edgePx;
}

export interface SwipeOutcome {
  // The claimed axis, or null if the gesture never resolved into one.
  axis: GestureAxis | null;
  // The direction along that axis, or null when unresolved.
  direction: GestureDirection | null;
  travel: number;
  velocity: number;
  // Whether it cleared distance-or-flick in `direction`.
  committed: boolean;
}

// The one-shot classification, for a surface that only cares about the ANSWER
// (the Timeline's adjacent-day navigation) rather than about following a finger.
// A gesture that never locks an axis — a tap, a diagonal, a vertical scroll on a
// horizontal surface — comes back uncommitted with a null direction, which is
// how "vertical scroll must win" is expressed: there is nothing to act on.
export function classifySwipe(
  from: GesturePoint,
  to: GesturePoint,
  thresholds: GestureThresholds = GESTURE_THRESHOLDS
): SwipeOutcome {
  const axis = lockedAxis(from, to, thresholds);
  if (!axis) {
    return {
      axis: null,
      direction: null,
      travel: 0,
      velocity: 0,
      committed: false,
    };
  }
  const direction: GestureDirection =
    axis === "x"
      ? to.x >= from.x
        ? "right"
        : "left"
      : to.y >= from.y
        ? "down"
        : "up";
  const travel = directedTravel(from, to, direction);
  const velocity = directedVelocity(from, to, direction);
  return {
    axis,
    direction,
    travel,
    velocity,
    committed: shouldCommit(travel, velocity, thresholds),
  };
}
