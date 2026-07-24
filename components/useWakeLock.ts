"use client";

import { useEffect, useRef } from "react";

// Shared best-effort screen wake lock (#1275) — extracted from LiveWorkoutPanel (#340) so
// the live workout panel and the fitness-check large timer share ONE implementation of the
// acquire + visibility-re-acquire dance, not two copies (the one-computation rule applied to
// behavior). Keeps the phone awake during a workout / a held plank / a balance stance.
//
// Best-effort by contract: absent (desktop / unsupported) or rejected (not user-activated)
// it silently no-ops, and the browser auto-releases the lock when the tab is hidden anyway —
// so we re-acquire when the tab returns to the foreground. Pass `enabled=false` to hold the
// lock off (e.g. while the timer overlay is collapsed).

// Minimal WakeLockSentinel typing — lib.dom's is behind a flag not enabled here.
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

export function useWakeLock(enabled: boolean = true): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike })
      .wakeLock;
    if (!wakeLock) return;
    let released = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        sentinelRef.current = await wakeLock.request("screen");
      } catch {
        // Denied/unsupported — the timer still runs; the screen may just dim.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !released) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
    };
  }, [enabled]);
}
