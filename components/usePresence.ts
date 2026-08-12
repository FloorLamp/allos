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
  const [presence, setPresence] = useState({ open, mounted: open });

  // Opening mounts immediately; closing keeps the prior mount only when an exit
  // animation actually has time to run. React retries this hook before children
  // commit, so prop and presence state are never one render out of step.
  if (
    presence.open !== open ||
    (!open && presence.mounted && durationMs <= 0)
  ) {
    setPresence({
      open,
      mounted: open || (durationMs > 0 && presence.mounted),
    });
  }

  useEffect(() => {
    if (open || !presence.mounted || durationMs <= 0) return;
    const timer = setTimeout(
      () =>
        setPresence((current) =>
          current.open ? current : { ...current, mounted: false }
        ),
      durationMs
    );
    return () => clearTimeout(timer);
  }, [open, durationMs, presence.mounted]);

  return { mounted: presence.mounted, phase: open ? "enter" : "exit" };
}
