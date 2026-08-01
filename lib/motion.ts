// Shared motion primitives (issue #1416, section F).
//
// The app animates in exactly two ways — a transform (slide/scale) and an
// opacity fade — and every one of them owes the viewer's
// `prefers-reduced-motion: reduce` an answer. Before this there was no shared
// vocabulary, so each new surface picked its own duration and re-decided the
// preference; that is the hand-mirrored-second-engine shape one level down from
// the "one question, one computation" rule.
//
// This module is the PURE half: the durations, and the ONE function that folds
// the preference into a duration. The CSS classes that consume them live in
// app/globals.css (`.motion-*`), and `components/usePresence.ts` is the mount /
// exit-transition hook every animated overlay uses so an exiting element stays
// mounted exactly as long as its animation runs. The preference itself is read
// by the ONE existing hook, components/usePrefersReducedMotion.ts.
//
// Keep these in sync with the `.motion-*` classes' `animation-duration`s — the
// hook uses the number to time the unmount, the CSS uses it to time the paint.

// The ONE overlay slide token pair (issue #1469). The app has three
// bottom/edge-anchored overlay surfaces — the nav drawer, BottomSheet, and the
// activity dock — whose DISMISSAL CONTRACTS differ by design (the #1428 decision
// rule: the sheet discards, the dock minimizes) but whose MOTION must not. Before
// this they each carried their own duration: 220ms for the drawer, 240ms for the
// sheet, none at all for the dock, which is the "hand-mirrored second engine"
// shape at the presentation layer — three surfaces answering "how fast does an
// overlay arrive?" three ways.
//
// The #1416 F slide-up values are the baseline and this is them: 240ms, with the
// decelerating cubic-bezier on the way in and a plain ease-in on the way out (an
// overlay should arrive gently and leave briskly). The CSS half lives in
// app/globals.css as `--overlay-ms` / `--overlay-ease-enter` / `--overlay-ease-exit`,
// and lib/__tests__/motion-tokens.test.ts pins the two copies of the number
// together — a stylesheet that outlives its JS duration leaves a frozen panel on
// screen, and one that undercuts it truncates the exit.
export const OVERLAY_MOTION_MS = 240;
export const OVERLAY_EASE_ENTER = "cubic-bezier(0.32, 0.72, 0, 1)";
export const OVERLAY_EASE_EXIT = "ease-in";

export const MOTION_MS = {
  // The three overlay surfaces all ride the ONE token above (#1469) — they are
  // named separately only so a call site still reads as what it animates.
  drawer: OVERLAY_MOTION_MS,
  sheet: OVERLAY_MOTION_MS,
  dock: OVERLAY_MOTION_MS,
  // The mobile profile switcher's top drawer (#1801) — a fourth tenant of the
  // same token, named for what it animates like the other three.
  switcher: OVERLAY_MOTION_MS,
  // Height-animated open/close of an inline region (components/Collapse).
  collapse: 200,
  // The shell chrome's hide/reveal slide (MobileNav's sticky bar + view strip).
  chrome: 180,
} as const;

export type MotionKind = keyof typeof MOTION_MS;

// The duration a surface should actually use. Under reduced motion every
// animation collapses to 0ms — the element still MOUNTS and UNMOUNTS in the same
// order, it just arrives instantly (a snap, not a missing state), which is what
// the preference asks for and what keeps the e2e reduced-motion path honest.
export function motionMs(kind: MotionKind, reduceMotion: boolean): number {
  return reduceMotion ? 0 : MOTION_MS[kind];
}

// The class list for an animated surface: the caller's base classes plus the
// `.motion-*` enter/exit class, dropped entirely under reduced motion so no
// keyframe is ever scheduled. `phase` comes from usePresence.
export function motionClass(
  base: string,
  animation: string | null,
  reduceMotion: boolean
): string {
  return reduceMotion || !animation ? base : `${base} ${animation}`;
}

// ── The overlay motion vocabulary (issue #1469) ──────────────────────────────
//
// Which part of an overlay is moving, and how it enters/leaves:
//
//   * "bottom"  — a bottom-anchored panel: BottomSheet, and the activity dock's
//                 expanded editor. Slides up from below the fold.
//   * "left"    — an edge-anchored panel: the mobile nav drawer.
//   * "top"     — a TOP-anchored panel: the mobile profile switcher (#1801),
//                 which drops from the identity bar so the target appears where
//                 the finger already is. Slides down from above the fold.
//   * "dialog"  — BottomSheet's responsive presentation: the bottom slide below
//                 `md`, a fade from `md` up (a slide-up on a CENTERED card reads
//                 as the card falling off the screen). The media query lives in
//                 the stylesheet, so ONE class name is right at both widths with
//                 no resize listener and no wrong first paint.
//   * "scrim"   — the backdrop behind any of them. Fades, never slides.
//
// This is the only place that names an `.overlay-*` class. Every overlay surface
// calls this function instead of writing the class string itself, which is what
// makes "one duration + easing token pair" enforceable rather than aspirational
// — see lib/__tests__/overlay-motion-chokepoint.test.ts.
export type OverlayAnchor = "bottom" | "left" | "top" | "dialog" | "scrim";

export function overlayMotionClass(
  anchor: OverlayAnchor,
  phase: "enter" | "exit",
  reduceMotion: boolean
): string {
  // Reduced motion gets no keyframe at all — the surface still MOUNTS and
  // UNMOUNTS in the same order (usePresence collapses its duration to 0), it
  // simply arrives. #794 8d / #1416 F posture, applied to all three surfaces.
  if (reduceMotion) return "";
  return `overlay-${phase}-${anchor}`;
}
