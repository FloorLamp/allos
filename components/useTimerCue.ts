"use client";

import { useCallback, useRef } from "react";
import { useHaptics } from "./useHaptics";

// Both activity timers share this best-effort cue. Their visual/aria completion
// stands independently when audio is blocked or the device has no vibration API.
export function useTimerCue(): () => void {
  const audioRef = useRef<AudioContext | null>(null);
  const haptic = useHaptics();
  return useCallback(() => {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) {
        const ctx = audioRef.current ?? new Ctor();
        audioRef.current = ctx;
        void ctx.resume?.().catch(() => {});
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.42);
      }
    } catch {
      // Denied audio must not prevent the haptic or the caller's visible end state.
    }
    haptic("alert");
  }, [haptic]);
}
