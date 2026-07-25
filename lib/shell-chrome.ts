// The auto-hiding mobile shell chrome (issue #1416, section B/C) — the PURE
// scroll-direction state machine behind it.
//
// The phone's top bar plus the multi-profile view banner ride together as ONE
// sticky unit: it slides out of the way while you scroll DOWN through a long
// page and comes straight back on ANY scroll-up or at the top, so the hamburger,
// search, and "whose data am I looking at?" are always one flick away without
// permanently spending 56px of a 844px-tall screen.
//
// The decision is extracted here because it is exactly the kind of thing that
// looks trivial and isn't: naive `y > lastY` flips the bar on every rubber-band
// pixel, on iOS overscroll (negative y), and on the tiny layout-shift scrolls a
// revalidating RSC causes. The rules below are the whole contract, and they are
// unit-testable without a browser (components/useShellChrome.ts is the thin
// listener that feeds it). Reduced motion is NOT modelled here — the machine
// decides WHETHER the chrome is hidden; whether that change is animated or
// snapped is a presentation concern (lib/motion.ts).

export interface ShellChromeState {
  // True while the chrome is translated out of view.
  hidden: boolean;
  // The scroll offset the last accepted decision was made at.
  lastY: number;
}

export interface ShellChromeThresholds {
  // Within this many pixels of the top the chrome is ALWAYS shown — the page
  // header region should never be covered by a hidden bar, and iOS rubber-band
  // overscroll (negative scrollY) lands here too.
  topZonePx: number;
  // The chrome never hides before the page has scrolled this far, so a short
  // page (or the first flick of a long one) can't strand the bar off-screen.
  hideAfterPx: number;
  // Movement smaller than this is jitter — a revalidating RSC's layout shift, a
  // trackpad micro-scroll — and changes nothing.
  jitterPx: number;
}

export const SHELL_CHROME_THRESHOLDS: ShellChromeThresholds = {
  topZonePx: 24,
  hideAfterPx: 96,
  jitterPx: 8,
};

export const INITIAL_SHELL_CHROME: ShellChromeState = {
  hidden: false,
  lastY: 0,
};

// The next state for a scroll offset. Returns the SAME object when nothing
// changes so a React consumer can bail out of a re-render on every scroll frame.
export function nextShellChrome(
  state: ShellChromeState,
  scrollY: number,
  thresholds: ShellChromeThresholds = SHELL_CHROME_THRESHOLDS
): ShellChromeState {
  // Overscroll past the top reports a negative offset on iOS (and a bounce past
  // the bottom can report beyond the document height); clamp so the top zone
  // covers the whole rubber-band range and the machine never sees a phantom
  // "scrolled up by 40px" as the bounce settles.
  const y = Number.isFinite(scrollY) ? Math.max(0, scrollY) : state.lastY;

  if (y <= thresholds.topZonePx) {
    return state.hidden || state.lastY !== y
      ? { hidden: false, lastY: y }
      : state;
  }

  const moved = y - state.lastY;
  if (Math.abs(moved) < thresholds.jitterPx) return state;

  // Scrolling up always reveals — the gesture IS the request for the chrome.
  if (moved < 0) {
    return state.hidden || state.lastY !== y
      ? { hidden: false, lastY: y }
      : state;
  }

  const hidden = state.hidden || y > thresholds.hideAfterPx;
  return state.hidden === hidden && state.lastY === y
    ? state
    : { hidden, lastY: y };
}

// A route change re-anchors the machine at the new page's scroll offset with the
// chrome revealed: the destination renders at the top, and carrying the previous
// page's `hidden` across would open a new page with its header covered.
export function resetShellChrome(scrollY = 0): ShellChromeState {
  return {
    hidden: false,
    lastY: Math.max(0, Number.isFinite(scrollY) ? scrollY : 0),
  };
}
