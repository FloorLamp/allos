"use client";

import { useEffect, useRef } from "react";
import { useShellChrome } from "./useShellChrome";

// The app shell's sticky top chrome (issue #1416, sections B + C).
//
// ONE sticky element holds BOTH the phone top bar (`children` — MobileNav's
// md:hidden bar) and the multi-profile view banner (`banner` —
// ProfileViewStrip), so they hide and reveal as a single unit and can never
// drift apart vertically. That is also why the banner moved out of the content
// flow: on a phone it used to scroll away, and "whose data am I looking at?" is
// exactly the question you need answered mid-scroll, not only at the top.
//
// Hide/reveal is transform-only: the element keeps its box (no layout thrash,
// no reflow of the page under it) and slides up by its own height MINUS the
// notch inset, so the safe-area strip under the status bar stays painted with
// the chrome's background instead of flashing page content through the notch.
// The transform lives on this ONE element (`.shell-chrome` in app/globals.css),
// which is the seam #1425's drag gesture will drive.
//
// Desktop is deliberately untouched: the bar is `md:hidden`, and the wrapper
// drops to `static` at `md`, so the banner sits exactly where it always did in
// the desktop reading column and nothing sticks.
//
// The banner is passed in (already rendered, possibly null) rather than
// constructed here — it is a Server Component reading the session's view-set,
// and this file only owns placement + motion.
export default function ShellChrome({
  children,
  banner,
}: {
  children: React.ReactNode;
  banner?: React.ReactNode;
}) {
  const { hidden, ready } = useShellChrome();
  const ref = useRef<HTMLDivElement>(null);
  // Publish the chrome's own height as `--shell-chrome-h` on <html>, so a page can
  // park a SECOND sticky strip directly beneath it and ride the same hide/reveal
  // (the Trends context bar — issue #1485 F — is the first). The height is not a
  // constant: the bar is one row, but the multi-profile view banner rides inside
  // this same element when a view-set is active, and both can wrap. Measured rather
  // than assumed, with the CSS declaring a sane pre-hydration default.
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
      {/* The banner BAND is the surface below `md` (issue #1539). It carries the
          brand wash edge-to-edge — "this bar means multi-profile" survives as a
          colour signal — so the strip inside it needs no frame, no tint and no
          background of its own; two translucent layers used to stack here and page
          content bled through the gaps above and below the floating card. The
          padding is `py-1.5`, not `py-3`: the band was 77px tall, TALLER than the
          57px nav bar above it, for a component whose own doc comment calls it
          "the thin persistent multi-profile banner". 47px now.
          From `md` up the band drops to transparent and the strip becomes the card
          again, in the ordinary reading column with its unchanged pt-8 / pb-4. */}
      {banner && (
        <div className="border-b border-brand-200 bg-brand-50/85 backdrop-blur-xl md:border-0 md:bg-transparent md:backdrop-blur-none dark:border-brand-500/25 dark:bg-brand-950/85 md:dark:bg-transparent">
          <div className="mx-auto py-1.5 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pt-8 md:pb-4 md:pl-[max(1.25rem,env(safe-area-inset-left))] md:pr-[max(1.25rem,env(safe-area-inset-right))] 3xl:max-w-[110rem]">
            {banner}
          </div>
        </div>
      )}
    </div>
  );
}
