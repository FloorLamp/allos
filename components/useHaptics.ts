"use client";

import { useCallback } from "react";
import { hapticPattern, type HapticEvent } from "@/lib/haptics";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

// The one adapter between the pure haptic policy (lib/haptics) and the Vibration API
// (issue #1422). Returns a `fire(event)` you can call from any cue site; it picks the
// pattern, honors prefers-reduced-motion, and degrades to a silent no-op where the API
// is absent (desktop, iOS Safari) or throws (some embedded webviews).
//
// Haptics are ADDITIVE by contract — the visual rest countdown and the set list stay the
// source of truth — so every one of those degradations loses nothing.
export function useHaptics(): (event: HapticEvent) => void {
  const reduceMotion = usePrefersReducedMotion();
  return useCallback(
    (event: HapticEvent) => {
      const pattern = hapticPattern(event, { reduceMotion });
      if (!pattern) return;
      try {
        navigator.vibrate?.([...pattern]);
      } catch {
        // Vibration API absent or blocked — the visual cue stands in.
      }
    },
    [reduceMotion]
  );
}
