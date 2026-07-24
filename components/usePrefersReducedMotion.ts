"use client";

import { useEffect, useState } from "react";

// Whether the viewer asked for reduced motion (#1307) — the ONE implementation, shared
// by every surface that owes the preference an answer. Extracted from FitnessCheckView
// when haptics (#1422) became the second caller: a buzz is motion the body feels, so the
// same preference gates it, and two copies of a media-query subscription is exactly the
// hand-mirrored-second-engine shape the one-computation rule exists to stop.
//
// Read AFTER mount, defaulting false, so SSR and the first client render agree (no
// hydration mismatch); the effect corrects it immediately. Playwright's `reducedMotion`
// context option flips the underlying query, so specs can drive both branches.
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}
