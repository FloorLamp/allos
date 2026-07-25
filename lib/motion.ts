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

export const MOTION_MS = {
  // Drawer slide-in/out + its backdrop fade (MobileNav).
  drawer: 220,
  // Bottom sheet slide-up/down + its backdrop fade (components/BottomSheet).
  sheet: 240,
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
