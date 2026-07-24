"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  INITIAL_SHELL_CHROME,
  nextShellChrome,
  resetShellChrome,
} from "@/lib/shell-chrome";

// The thin browser half of the auto-hiding shell chrome (issue #1416) — a
// passive scroll listener, rAF-coalesced, feeding the PURE state machine in
// lib/shell-chrome.ts. Everything that DECIDES anything lives there; this file
// only supplies `window.scrollY` and re-anchors on navigation.
//
// Coalescing matters: a phone fires scroll events far faster than it paints, and
// setState per event would re-render the whole chrome dozens of times a frame.
// One rAF-scheduled read per frame is enough for a transform that itself only
// paints once a frame, and the machine returns the SAME object when nothing
// changed so React bails out of most of those renders anyway.

export function useShellChrome(): boolean {
  const pathname = usePathname();
  const [state, setState] = useState(INITIAL_SHELL_CHROME);

  // A route change lands at (or near) the top with the chrome revealed —
  // carrying the previous page's hidden state across would open a new page with
  // its heading covered.
  useEffect(() => {
    setState(resetShellChrome(window.scrollY));
  }, [pathname]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setState((prev) => nextShellChrome(prev, window.scrollY));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return state.hidden;
}
