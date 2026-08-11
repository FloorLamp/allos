"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useHydrated } from "./useHydrated";
import {
  INITIAL_SHELL_CHROME,
  nextShellChrome,
  resetShellChrome,
} from "@/lib/shell-chrome";

const REVEAL_SHELL_CHROME_EVENT = "allos:reveal-shell-chrome";

// Interactive sub-chrome can change the document height without the user
// scrolling (for example, closing Trends' expanded range controls). Re-anchor
// every shell-chrome listener after that layout settles so the synthetic scroll
// event cannot hide the nav the user just interacted with.
export function revealShellChrome(): void {
  window.dispatchEvent(new Event(REVEAL_SHELL_CHROME_EVENT));
}

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
  const [routeState, setRouteState] = useState({
    pathname,
    state: INITIAL_SHELL_CHROME,
  });
  if (routeState.pathname !== pathname) {
    setRouteState({ pathname, state: resetShellChrome(window.scrollY) });
  }
  const state = routeState.state;
  // Flipped once the scroll listener is attached. The behavior is inherently
  // hydration-gated (a server-rendered bar has no listener, so a scroll before
  // hydration is simply not seen — the chrome stays revealed, which is the safe
  // state), and surfacing that as `data-ready` lets a browser test wait for the
  // real thing instead of racing it. Deliberately NOT a scroll-position sync on
  // attach: arriving at a restored mid-page offset should show the chrome, not
  // hide it.
  const ready = useHydrated();

  useEffect(() => {
    let frame = 0;
    const onReveal = () => {
      setRouteState({ pathname, state: resetShellChrome(window.scrollY) });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setRouteState((previous) => ({
          pathname,
          state: nextShellChrome(previous.state, window.scrollY),
        }));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(REVEAL_SHELL_CHROME_EVENT, onReveal);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(REVEAL_SHELL_CHROME_EVENT, onReveal);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return { hidden: state.hidden, ready };
}
