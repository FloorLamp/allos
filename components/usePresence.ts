"use client";

import { useEffect, useState } from "react";

// Mount/exit presence for an animated overlay (issue #1416, section F).
//
// An overlay rendered as `{open && <Panel/>}` can only animate IN — the moment
// `open` flips false the element is gone, so there is nothing left to animate
// out. This hook keeps it mounted for exactly the length of its exit animation
// and then unmounts it, so a drawer/sheet can slide both ways while still
// reaching a real unmounted state (which matters beyond aesthetics: the e2e
// suite asserts `toHaveCount(0)` after closing, and a permanently-mounted
// overlay would leave duplicate labelled controls in the accessibility tree).
//
// `durationMs` comes from lib/motion.ts's `motionMs(kind, reduceMotion)`, so a
// reduced-motion viewer passes 0 and the unmount is immediate — the same state
// sequence, snapped.

export type PresencePhase = "enter" | "exit";

export function usePresence(
  open: boolean,
  durationMs: number
): { mounted: boolean; phase: PresencePhase } {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<PresencePhase>(open ? "enter" : "exit");

  useEffect(() => {
    if (open) {
      setMounted(true);
      setPhase("enter");
      return;
    }
    setPhase("exit");
    if (durationMs <= 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer);
  }, [open, durationMs]);

  return { mounted, phase };
}
