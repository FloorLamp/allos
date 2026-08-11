"use client";

import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

// Whether the viewer asked for reduced motion (#1307) — the ONE implementation, shared
// by every surface that owes the preference an answer. Extracted from FitnessCheckView
// when haptics (#1422) became the second caller: a buzz is motion the body feels, so the
// same preference gates it, and two copies of a media-query subscription is exactly the
// hand-mirrored-second-engine shape the one-computation rule exists to stop.
//
// The server snapshot is false, so SSR and the first hydration pass agree. React then
// reads the media-query snapshot and subscribes to later OS changes without a
// setState-in-effect handoff. Playwright's `reducedMotion` context option flips the
// underlying query, so specs can drive both branches.
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false
  );
}
