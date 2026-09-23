"use client";

import { useCallback } from "react";
import { useHaptics } from "./useHaptics";
import { useTone } from "./useTone";

// Both activity timers share this best-effort cue. Their visual/aria completion
// stands independently when audio is blocked or the device has no vibration API.
export function useTimerCue(): () => void {
  const tone = useTone();
  const haptic = useHaptics();
  return useCallback(() => {
    tone("alert");
    haptic("alert");
  }, [tone, haptic]);
}
