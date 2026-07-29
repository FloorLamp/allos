"use client";

import { useEffect } from "react";

// Keep a `/trends#section` deep link honest on a STREAMED page (#1644).
//
// The browser resolves a URL fragment when it parses the element. On this page the
// census sections stream in through Suspense, so at parse time `#fitness` is a
// placeholder — and every byte that arrives above the target afterwards pushes it
// further down the document. The native scroll therefore lands somewhere useless,
// which would quietly break exactly the links this issue moved everything to (the
// coaching engine's `#zones`, the dashboard's `#body`, every finding CTA).
//
// So: re-align to the target while the page is still assembling, and stop the
// moment the reader takes over.
//
//   • Only ever runs when the URL names a fragment, and only on mount.
//   • A MutationObserver re-aligns as sections arrive (scroll-margin is honoured by
//     scrollIntoView, so the sticky chip strip is cleared exactly as a chip tap
//     clears it).
//   • ANY user scroll gesture cancels it permanently, and it gives up on its own
//     after the settle window — this must never fight a reader who has moved on.
//
// In-page chip taps need none of this: by then the section exists and the plain
// anchor does the work.
const SETTLE_MS = 4000;

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

    let cancelled = false;
    const align = () => {
      if (cancelled) return;
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    };
    const observer = new MutationObserver(align);
    const stop = () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      for (const event of GESTURES) window.removeEventListener(event, stop);
    };
    const timer = window.setTimeout(stop, SETTLE_MS);
    const GESTURES = ["wheel", "touchmove", "keydown"] as const;
    for (const event of GESTURES) {
      window.addEventListener(event, stop, { passive: true });
    }

    align();
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, []);

  return null;
}
