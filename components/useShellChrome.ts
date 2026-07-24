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

export function useShellChrome(): { hidden: boolean; ready: boolean } {
  const pathname = usePathname();
  const [state, setState] = useState(INITIAL_SHELL_CHROME);
  // Flipped once the scroll listener is attached. The behavior is inherently
  // hydration-gated (a server-rendered bar has no listener, so a scroll before
  // hydration is simply not seen — the chrome stays revealed, which is the safe
  // state), and surfacing that as `data-ready` lets a browser test wait for the
  // real thing instead of racing it. Deliberately NOT a scroll-position sync on
  // attach: arriving at a restored mid-page offset should show the chrome, not
  // hide it.
  const [ready, setReady] = useState(false);

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
    setReady(true);
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return { hidden: state.hidden, ready };
}
