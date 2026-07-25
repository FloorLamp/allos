// Pull-to-refresh gesture classification (issue #1428, section B) — the PURE half.
//
// Installed to the home screen, the app runs in `display-mode: standalone`: no
// URL bar, and therefore no refresh control. A page that has gone stale — another
// device logged a dose, the notify tick moved something — has no recovery gesture
// at all short of force-quitting. The overscroll pull every native app answers to
// is the missing affordance.
//
// The DOM half (components/PullToRefresh.tsx) owns listeners, transforms and the
// `router.refresh()`; this owns the decision, so "was that a refresh?" is
// testable without a browser and reads the same way at every call site. The same
// split #1425's swipe util uses.
//
// The four things that make a touch a pull-to-refresh, all of which have to hold:
//
//   1. It STARTED at the top of the page. Otherwise it is ordinary scrolling.
//   2. It is STILL at the top. A flick that begins at the top and scrolls away
//      mid-gesture is a scroll, and arming a refresh underneath it would fire on
//      release far down the page.
//   3. It is DOWNWARD. Pulling up at the top is a scroll into the page.
//   4. It is more vertical than horizontal — otherwise a sideways swipe (the
//      horizontal chip strips, a chart pan) would arm the refresh as a side
//      effect of its small vertical wobble.

// Travel (after resistance) that arms the refresh. Releasing below it snaps back.
export const PTR_TRIGGER_PX = 64;
// Cap on indicator travel, so a long drag doesn't pull the indicator off-screen.
export const PTR_MAX_PX = 96;
// How much of the finger's travel the indicator actually moves. The drag feels
// weighted rather than sticky-to-the-finger, and — more usefully — it makes the
// gesture DELIBERATE: 128px of travel to arm, which a scroll flick doesn't
// accidentally produce.
export const PTR_RESISTANCE = 0.5;
// Scroll offset still counted as "at the top". Momentum and sub-pixel rounding
// leave a scrollY of 0.5 at rest on some devices; requiring an exact 0 makes the
// gesture intermittently impossible.
export const PTR_TOP_SLOP_PX = 2;

export interface PullInput {
  // Document scroll offset when the touch STARTED.
  startScrollY: number;
  // Document scroll offset right now.
  scrollY: number;
  // Vertical finger travel since the touch started; positive is downward.
  deltaY: number;
  // Horizontal finger travel since the touch started (sign irrelevant).
  deltaX: number;
}

export type PullState =
  // Not a pull-to-refresh gesture. The component shows nothing and a release
  // does nothing.
  | { kind: "idle" }
  // A pull in progress, below the arming threshold: releasing snaps back.
  | { kind: "pulling"; distance: number; progress: number }
  // Past the threshold: releasing refreshes.
  | { kind: "armed"; distance: number; progress: number };

// Classify the gesture so far. Pure and total; `progress` is 0..1 against the
// arming threshold, for the indicator's rotation/opacity.
export function classifyPull(input: PullInput): PullState {
  const { startScrollY, scrollY, deltaY, deltaX } = input;
  if (startScrollY > PTR_TOP_SLOP_PX) return { kind: "idle" };
  if (scrollY > PTR_TOP_SLOP_PX) return { kind: "idle" };
  if (deltaY <= 0) return { kind: "idle" };
  // Strictly more vertical than horizontal — a 45° diagonal is not a pull.
  if (deltaY <= Math.abs(deltaX)) return { kind: "idle" };

  const distance = Math.min(PTR_MAX_PX, deltaY * PTR_RESISTANCE);
  const progress = Math.min(1, distance / PTR_TRIGGER_PX);
  return distance >= PTR_TRIGGER_PX
    ? { kind: "armed", distance, progress }
    : { kind: "pulling", distance, progress };
}

// Does releasing here run the refresh? Only from `armed` — the one place the
// component is allowed to call router.refresh().
export function shouldRefresh(state: PullState): boolean {
  return state.kind === "armed";
}
