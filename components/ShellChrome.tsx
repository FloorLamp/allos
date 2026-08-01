"use client";

import { useEffect, useRef } from "react";
import { useShellChrome } from "./useShellChrome";
import ShellTabStrip from "./ShellTabStrip";
import type { TabFirstPageConfig } from "./tab-first-pages";

// The app shell's sticky top chrome (issue #1416, sections B + C).
//
// ONE sticky element holds the phone top bar (`children` — MobileNav's
// md:hidden bar) and any route-registered mobile tab-first strip. They hide and
// reveal as a single unit and can never drift apart vertically.
//
// The separate multi-profile view BANNER this used to carry is gone (#1801): the
// identity bar answers "whose data am I looking at?" from inside the top bar
// itself, so the promise #1416 made — that the question stays answerable
// mid-scroll — is now kept by one surface instead of two.
//
// Hide/reveal is transform-only: the element keeps its box (no layout thrash,
// no reflow of the page under it) and slides up by its own height MINUS the
// notch inset, so the safe-area strip under the status bar stays painted with
// the chrome's background instead of flashing page content through the notch.
// The transform lives on this ONE element (`.shell-chrome` in app/globals.css),
// which is the seam #1425's drag gesture will drive.
//
// Desktop is deliberately untouched: the bar is `md:hidden`, and the wrapper
// drops to `static` at `md`, so nothing sticks there.
export default function ShellChrome({
  children,
  disabledTabFirstPageIds,
}: {
  children: React.ReactNode;
  disabledTabFirstPageIds?: readonly TabFirstPageConfig["pageId"][];
}) {
  const { hidden, ready } = useShellChrome();
  const ref = useRef<HTMLDivElement>(null);
  // Publish the chrome's own height as `--shell-chrome-h` on <html>, so a page can
  // park a SECOND sticky strip directly beneath it and ride the same hide/reveal
  // (the Trends context bar — issue #1485 F — is the first). The height is not a
  // constant: the tab-first strip rides inside this same element on the routes
  // that register one, and the bar itself can grow with the notch inset. Measured
  // rather than assumed, with the CSS declaring a sane pre-hydration default.
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
      className="shell-chrome sticky top-0 z-30 md:static print:hidden"
    >
      {children}
      <ShellTabStrip disabledPageIds={disabledTabFirstPageIds} />
    </div>
  );
}
