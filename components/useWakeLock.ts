"use client";

import { useEffect, useRef } from "react";
import { wakeLockAction } from "@/lib/wake-lock";

// Shared best-effort screen wake lock (#1275) — extracted from LiveWorkoutPanel (#340) so
// the live workout panel and the fitness-check large timer share ONE implementation of the
// acquire + visibility-re-acquire dance, not two copies (the one-computation rule applied to
// behavior). Keeps the phone awake during a workout / a held plank / a balance stance.
//
// Best-effort by contract: absent (desktop / unsupported) or rejected (not user-activated)
// it silently no-ops, and the browser auto-releases the lock when the tab is hidden anyway —
// so we re-acquire when the tab returns to the foreground. Pass `enabled=false` to hold the
// lock off (e.g. while the timer overlay is collapsed, or the live workout is minimized to
// the dock — #1422; the dock keeps the editor MOUNTED, so the old unmount-only release
// never fired there and the phone stayed awake for the rest of the day).
//
// WHEN to hold is the pure `wakeLockAction` (lib/wake-lock.ts); this hook is only the
// adapter that reads real `navigator`/`document` state and performs the action it returns.

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
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike })
      .wakeLock;
    // `request` is async, so a visibility flip can land mid-flight: `cancelled` drops a
    // sentinel that arrives after we stopped wanting one, and `pending` keeps a burst of
    // visibilitychange events from stacking overlapping requests.
    let cancelled = false;
    let pending = false;

    const sync = async (wanted: boolean) => {
      const action = wakeLockAction({
        wanted,
        supported: wakeLock != null,
        visible: document.visibilityState === "visible",
        held: sentinelRef.current != null,
      });
      if (action === "none") return;
      if (action === "release") {
        const sentinel = sentinelRef.current;
        sentinelRef.current = null;
        await sentinel?.release().catch(() => {});
        return;
      }
      if (pending || !wakeLock) return;
      pending = true;
      try {
        const sentinel = await wakeLock.request("screen");
        if (cancelled) void sentinel.release().catch(() => {});
        else sentinelRef.current = sentinel;
      } catch {
        // Denied/unsupported — the timer still runs; the screen may just dim.
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => void sync(enabled);
    void sync(enabled);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sync(false);
    };
  }, [enabled]);
}
