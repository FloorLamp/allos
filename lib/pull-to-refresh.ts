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
// The five things that make a touch a pull-to-refresh, all of which have to hold:
//
//   1. NO OVERLAY OWNS THE VERTICAL DRAG. While a sheet, drawer or the workout
//      dock is up, a downward drag belongs to that surface's own dismiss
//      gesture. Without this clause a bottom sheet's drag-dismiss — down, from a
//      page sitting at its top, well past the arming distance — is
//      indistinguishable from a pull, so in the installed app every drag-dismiss
//      fired a whole-page `router.refresh()` inside the sheet's exit window and
//      surfaced the PTR spinner (`z-90`) over the sheet (`z-60`) (#2725).
//      NOT "is anything on top of the page" — see `overlayOwnsViewport` below,
//      where the difference is the whole point.
//   2. It STARTED at the top of the page. Otherwise it is ordinary scrolling.
//   3. It is STILL at the top. A flick that begins at the top and scrolls away
//      mid-gesture is a scroll, and arming a refresh underneath it would fire on
//      release far down the page.
//   4. It is DOWNWARD. Pulling up at the top is a scroll into the page.
//   5. It is more vertical than horizontal — otherwise a sideways swipe (the
//      horizontal chip strips, a chart pan) would arm the refresh as a side
//      effect of its small vertical wobble.

// ── Clause 1: does an overlay own the vertical drag? ─────────────────────────
//
// The facts a caller supplies, and the decision over them. Pure, and HERE rather
// than in the component, because the first version of this got it wrong in a way
// only a test could have caught and the test had nowhere to live.
//
// The measure is BODY SCROLL LOCK, and only that. `useLockBodyScroll` is the
// only writer of `body.style.overflow` in the app, and every one of its callers
// is a surface that has taken the screen: the bottom sheet, both mobile drawers,
// the workout dock, the command palette, the mobile detail page, the image
// cropper. That is exactly the set that owns the vertical drag — every
// downward-capable recognizer in the app (both `direction: "down"` overlay drags
// and the cropper's own) runs under a locked body. And the lock is a
// DOCUMENT-level fact, so it also covers a drag begun on a sheet's scrim, which
// is a sibling of the panel and inside no dialog at all.
//
// WHAT THIS DELIBERATELY DOES NOT ASK IS "is a modal open?" — that was the first
// version and it was WRONG. It was added to catch four surfaces that never lock
// (ModalShell and its 31 consumers, MergeConflictDialog, PhotoGallery,
// FitnessTestTimer), but standing down under those is not a fix, it is a second
// bug: none of the four has a touch gesture of any kind, so none can produce the
// drag this clause exists to refuse, and a pull under one of them is a contract
// the suite already pins. `e2e/dirty-form-refresh.mobile.spec.ts` asserts that a
// pull STILL REFRESHES while a record form (an `aria-modal` ModalShell) holds
// unsaved input — per #1878 a refresh the USER asked for is never deferred, and
// installed there is no other way to ask, so swallowing it would leave someone
// pulling with no recourse.
//
// The two questions are not interchangeable. "Is a modal open" is about
// ATTENTION; this is about whether an overlay owns the vertical DRAG. A new fact
// belongs here only if it names a surface that owns the gesture, and it owes
// this module a test in BOTH directions.
export interface ViewportOwnershipFacts {
  // Has an overlay locked body scroll? (`document.body.style.overflow`.)
  bodyScrollLocked: boolean;
}

export function overlayOwnsViewport(facts: ViewportOwnershipFacts): boolean {
  return facts.bodyScrollLocked;
}

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
  // Did a full-screen surface own the viewport when the touch STARTED? Read
  // once, at the start, and carried for the whole gesture — the DOM half owns
  // the reading (components/PullToRefresh.tsx's `overlayOwnsViewport`).
  //
  // AT THE START is the load-bearing half, not a shortcut to avoid a per-frame
  // DOM read. The reported gesture DISMISSES the overlay it began in, so by the
  // last touchmove there is no overlay left to see: re-asking mid-gesture would
  // answer "no overlay" for the closing half of every drag-dismiss and re-arm
  // the refresh the first clause exists to refuse.
  overlayOpen: boolean;
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
  const { overlayOpen, startScrollY, scrollY, deltaY, deltaX } = input;
  if (overlayOpen) return { kind: "idle" };
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

// Where the indicator sits, how visible it is, and how far the icon has spun.
// `translateY` and `rotation` are the container/badge transforms; `opacity` is
// the container's.
export interface IndicatorPresentation {
  translateY: number;
  opacity: number;
  rotation: number;
}

// The indicator's whole visual state, so it is decidable without a browser —
// the component (which only renders in `display-mode: standalone`, and so is
// invisible to every e2e run) is a straight renderer of these three numbers.
//
// Idle with nothing pending means the gesture is over and there is no refresh in
// flight: the indicator is GONE. Its resting position is on-screen — `fixed
// top-0` plus a positive safe-area margin — so anything short of opacity 0 there
// leaves the icon parked at the top of the page forever (issue #1794).
//
// Under `prefers-reduced-motion` the indicator does not travel with the finger:
// it sits at its resting offset and simply appears once the pull is armed. The
// preference asks for no motion, not for no feedback.
export function indicatorPresentation(
  state: PullState,
  pending: boolean,
  reduceMotion: boolean
): IndicatorPresentation {
  const active = state.kind !== "idle";
  const committed = state.kind === "armed" || pending;

  if (reduceMotion) {
    return {
      translateY: active || pending ? PTR_MAX_PX / 2 : 0,
      opacity: committed ? 1 : 0,
      rotation: 0,
    };
  }

  // Mid-refresh the gesture is already released, so there is no finger to track:
  // the indicator holds at half travel until the transition settles.
  const distance = active ? state.distance : pending ? PTR_MAX_PX / 2 : 0;
  const progress = active ? state.progress : pending ? 1 : 0;
  return {
    translateY: distance,
    opacity: progress,
    rotation: Math.round(progress * 270),
  };
}
