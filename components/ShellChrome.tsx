"use client";

import { useEffect, useRef } from "react";
import { useShellChrome } from "./useShellChrome";
import ShellTabStrip from "./ShellTabStrip";
import type { TabFirstPageConfig } from "./tab-first-pages";

// The app shell's sticky top chrome (issue #1416, sections B + C).
//
// It was built to hold TWO things as one unit — the phone top bar and any
// route-registered tab-first strip — so they could hide and reveal together and
// never drift apart vertically. #4102 retired the top bar, and the view banner
// went in #1801 before it, so ONE thing is left: the strip. This element
// therefore renders NOTHING on a page that registers no strip, which is what
// "below `md` the shell renders zero top chrome" means in markup — an empty
// sticky box has no height, so the first page pixel is at the viewport top.
//
// It is not folded into ShellTabStrip. The hide-on-scroll behaviour, the
// `--shell-chrome-h` publication a page's own second sticky strip reads, and the
// `md:static` desktop opt-out are the shell's facts, not the strip's, and the
// strip's own file already returns null for the pages it does not serve.
//
// Hide/reveal is transform-only: the element keeps its box (no layout thrash, no
// reflow of the page under it) and slides up by its own height PLUS the notch
// inset, clearing the viewport. The shell paints no status-bar band to preserve
// (#4282) — this strip parks below the notch by carrying `top-edge-safe` itself,
// and the transform takes that offset back. Both live on this ONE element
// (`.shell-chrome` in app/globals.css), the seam #1425's drag gesture will drive.
//
// Desktop is deliberately untouched: the strip is `md:hidden`, and the wrapper
// drops to `static` at `md`, so nothing sticks there.
export default function ShellChrome({
  disabledTabFirstPageIds,
}: {
  disabledTabFirstPageIds?: readonly TabFirstPageConfig["pageId"][];
}) {
  const { hidden, ready } = useShellChrome();
  const ref = useRef<HTMLDivElement>(null);
  // Publish the chrome's own height as `--shell-chrome-h` on <html>, so a page can
  // park a SECOND sticky strip directly beneath it and ride the same hide/reveal
  // (the Trends context bar — issue #1485 F — is the first). The height is not a
  // constant: it is the strip's on a route that registers one and ZERO everywhere
  // else, which is the value a page below it needs most. Measured rather than
  // assumed, with the CSS declaring a sane pre-hydration default.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--shell-chrome-h",
        `${el.offsetHeight}px`
      );
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      data-testid="shell-chrome"
      data-hidden={hidden ? "true" : "false"}
      // The scroll listener only exists after hydration, so before it the chrome
      // is simply always revealed (the safe state). Surfaced so a browser test
      // can wait for the real behavior rather than race it.
      data-ready={ready ? "true" : "false"}
      className="shell-chrome sticky top-edge-safe z-30 md:static print:hidden"
    >
      <ShellTabStrip disabledPageIds={disabledTabFirstPageIds} />
    </div>
  );
}
