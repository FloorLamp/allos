import { describe, expect, it } from "vitest";
import {
  INITIAL_SHELL_CHROME,
  SHELL_CHROME_THRESHOLDS,
  nextShellChrome,
  resetShellChrome,
  type ShellChromeState,
} from "@/lib/shell-chrome";

// The auto-hiding mobile chrome's decision layer (issue #1416, section B). The
// browser half (components/useShellChrome.ts) only reads window.scrollY; every
// rule that can be wrong lives here.

const { topZonePx, hideAfterPx, jitterPx } = SHELL_CHROME_THRESHOLDS;

// Feed a sequence of scroll offsets through the machine.
function run(offsets: number[], from = INITIAL_SHELL_CHROME): ShellChromeState {
  return offsets.reduce((state, y) => nextShellChrome(state, y), from);
}

describe("nextShellChrome", () => {
  it("keeps the chrome visible at the top of the page", () => {
    expect(run([0]).hidden).toBe(false);
    expect(run([topZonePx]).hidden).toBe(false);
  });

  it("hides once a downward scroll passes the hide-after floor", () => {
    expect(run([400]).hidden).toBe(true);
  });

  it("does NOT hide on a short page's first flick (above the floor is required)", () => {
    // A page you can only scroll a little must never strand the bar off-screen.
    const state = run([hideAfterPx]);
    expect(state.hidden).toBe(false);
    expect(state.lastY).toBe(hideAfterPx);
  });

  it("reveals on ANY upward scroll, however deep in the page", () => {
    const hidden = run([2000]);
    expect(hidden.hidden).toBe(true);
    expect(nextShellChrome(hidden, 2000 - jitterPx).hidden).toBe(false);
  });

  it("reveals again on returning to the top", () => {
    expect(run([2000, 0]).hidden).toBe(false);
  });

  it("ignores sub-threshold jitter without re-anchoring lastY", () => {
    const hidden = run([500]);
    // A revalidating RSC nudging layout by a few pixels must not flip the bar…
    const jittered = nextShellChrome(hidden, 500 - (jitterPx - 1));
    expect(jittered).toBe(hidden);
    // …and because lastY stayed put, a genuine upward flick from there still
    // measures against the real anchor rather than a drifted one.
    expect(nextShellChrome(jittered, 500 - jitterPx).hidden).toBe(false);
  });

  it("treats iOS rubber-band overscroll (negative offsets) as the top", () => {
    const hidden = run([600]);
    expect(nextShellChrome(hidden, -80).hidden).toBe(false);
  });

  it("stays hidden while the downward scroll continues", () => {
    expect(run([400, 800, 1200]).hidden).toBe(true);
  });

  it("returns the SAME object when nothing changes, so React can bail out", () => {
    const settled = run([2000]);
    expect(nextShellChrome(settled, 2000)).toBe(settled);
    const top = run([0]);
    expect(nextShellChrome(top, 0)).toBe(top);
  });

  it("ignores a non-finite offset rather than corrupting the anchor", () => {
    const settled = run([600]);
    expect(nextShellChrome(settled, Number.NaN)).toBe(settled);
  });
});

describe("resetShellChrome", () => {
  it("re-anchors a route change with the chrome revealed", () => {
    expect(resetShellChrome(0)).toEqual({ hidden: false, lastY: 0 });
    expect(resetShellChrome(300)).toEqual({ hidden: false, lastY: 300 });
  });

  it("clamps a negative or non-finite offset", () => {
    expect(resetShellChrome(-40).lastY).toBe(0);
    expect(resetShellChrome(Number.NaN).lastY).toBe(0);
  });
});
