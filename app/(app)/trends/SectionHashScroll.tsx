"use client";

import { useEffect } from "react";

// Keep a `/trends#body` deep link honest on a STREAMED surface (#1644).
//
// The browser resolves a URL fragment when it parses the element. On the landing
// surface the body census streams in through Suspense, so at parse time `#body` is
// a placeholder — and every byte that arrives above the target afterwards pushes it
// further down the document. The native scroll therefore lands somewhere useless,
// which would quietly break exactly the links this issue rewrote: the dashboard
// widgets, the preventive/data-quality CTAs, the palette's log actions.
//
// So: re-align to the target while the page is still assembling, and stop the
// moment the reader takes over.
//
//   • Only ever runs when the URL names a fragment, and only on mount.
//   • A frame loop re-aligns while the page assembles (scroll-margin is honoured by
//     scrollIntoView, so the sticky tab strip is cleared just as it is for an
//     in-page anchor click).
//   • ANY user scroll gesture cancels it permanently, and it gives up on its own
//     after the settle window — this must never fight a reader who has moved on.
//
// An in-page anchor click needs none of this: by then the census exists and the
// browser does the work.
const SETTLE_MS = 2000;
// A gesture that means the reader has taken over. `pointerdown` covers a scrollbar
// drag, which produces no wheel or touch event.
const GESTURES = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

export default function SectionHashScroll() {
  useEffect(() => {
    const raw = window.location.hash.slice(1);
    if (!raw) return;
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }
    if (!id) return;

    let stopped = false;
    let frame = 0;
    let timer = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      for (const event of GESTURES) window.removeEventListener(event, stop);
    };
    // Re-align EVERY FRAME for the settle window rather than only on DOM changes.
    // Two things move the target after it first appears, and neither is a mutation
    // this component can see: React reveals the streamed boundary in a batch of its
    // own, and the browser's scroll restoration can land after that. A frame loop
    // simply keeps the anchor honest until the page stops moving under it.
    const align = () => {
      if (stopped) return;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
      frame = requestAnimationFrame(align);
    };

    timer = window.setTimeout(stop, SETTLE_MS);
    for (const event of GESTURES) {
      window.addEventListener(event, stop, { passive: true });
    }
    align();
    return stop;
  }, []);

  return null;
}
