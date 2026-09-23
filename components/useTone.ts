"use client";

import { useCallback, useRef } from "react";
import { HAPTIC_TONES, type HapticEvent } from "@/lib/haptics";

// The one adapter between the pure tone table (lib/haptics) and Web Audio (#5900),
// beside `useHaptics` and called with the same events. The `AudioContext` is created
// on the first tone, not on mount, and it degrades to a silent no-op where audio is
// absent, blocked or throws. Tones are additive like haptics: the visible state is
// always the source of truth.
export function useTone(): (event: HapticEvent) => void {
  const audioRef = useRef<AudioContext | null>(null);
  return useCallback((event: HapticEvent) => {
    const tone = HAPTIC_TONES[event];
    if (!tone) return;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      const ctx = (audioRef.current ??= new Ctor());
      void ctx.resume?.().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      osc.type = "sine";
      osc.frequency.value = tone.hz;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(tone.gain, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tone.seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(t + tone.seconds + 0.02);
    } catch {
      // Audio absent or denied — the visible state and the haptic stand in.
    }
  }, []);
}
