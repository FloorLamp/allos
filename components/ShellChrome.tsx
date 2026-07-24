"use client";

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
  const hidden = useShellChrome();
  return (
    <div
      data-testid="shell-chrome"
      data-hidden={hidden ? "true" : "false"}
      className="shell-chrome sticky top-0 z-30 md:static print:hidden"
    >
      {children}
      {banner && (
        <div className="border-b border-black/10 bg-white/80 backdrop-blur-xl md:border-0 md:bg-transparent md:backdrop-blur-none dark:border-white/5 dark:bg-ink-950/80 md:dark:bg-transparent">
          <div className="mx-auto pt-3 pb-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pt-8 md:pb-4 md:pl-[max(1.25rem,env(safe-area-inset-left))] md:pr-[max(1.25rem,env(safe-area-inset-right))] 3xl:max-w-[110rem]">
            {banner}
          </div>
        </div>
      )}
    </div>
  );
}
