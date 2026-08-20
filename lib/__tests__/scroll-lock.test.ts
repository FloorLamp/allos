import { describe, expect, it } from "vitest";
import {
  acquireScrollLock,
  EMPTY_SCROLL_LOCK,
  isScrollLocked,
  releaseScrollLock,
  type ScrollLockState,
} from "@/lib/scroll-lock";

// The nesting invariant #2774 made mandatory before the body-scroll lock could
// gain ModalShell's consumers: a dialog opened OVER an open sheet leaves the
// body locked when the INNER surface closes, and the page is released only by
// the LAST holder — in EITHER closing order.
//
// Both orders really happen. LIFO is the ordinary one (a confirm opened from a
// sheet, answered, gone). The other is what the save/restore version shipped a
// stuck installed app on: `usePresence` keeps a closing sheet MOUNTED through
// its exit animation, so a sheet that closed first can still release its lock
// AFTER the surface it opened.

function hold(state: ScrollLockState, n: number): ScrollLockState {
  let next = state;
  for (let i = 0; i < n; i += 1) next = acquireScrollLock(next);
  return next;
}

describe("scroll lock", () => {
  it("is unlocked with nobody holding", () => {
    expect(isScrollLocked(EMPTY_SCROLL_LOCK)).toBe(false);
  });

  it("locks while one surface holds and releases when it goes", () => {
    const held = acquireScrollLock(EMPTY_SCROLL_LOCK);
    expect(isScrollLocked(held)).toBe(true);
    expect(isScrollLocked(releaseScrollLock(held))).toBe(false);
  });

  it.each([
    ["the INNER surface closes first (LIFO)", ["dialog", "sheet"]],
    ["the OUTER surface closes first", ["sheet", "dialog"]],
  ])("keeps the page held while a stack unwinds — %s", (_when, order) => {
    // A sheet is open and a dialog opens over it. Whichever releases first, the
    // page stays held until the second one does. The count cannot tell the two
    // orders apart, and that indifference IS the invariant: the save/restore
    // lock could tell them apart, and got the second one wrong.
    const holders = new Map<string, boolean>([
      ["sheet", true],
      ["dialog", true],
    ]);
    let state = hold(EMPTY_SCROLL_LOCK, holders.size);
    expect(isScrollLocked(state)).toBe(true);

    const [first, second] = order;
    holders.delete(first);
    state = releaseScrollLock(state);
    expect(
      isScrollLocked(state),
      `${second} is still open, so the page must still be held`
    ).toBe(true);

    holders.delete(second);
    state = releaseScrollLock(state);
    expect(holders.size).toBe(0);
    expect(isScrollLocked(state)).toBe(false);
  });

  it("survives a double release without going negative", () => {
    // A cleanup that runs twice must not leave the count below zero, or the next
    // genuine lock would acquire to 0 and never lock the page at all.
    const once = acquireScrollLock(EMPTY_SCROLL_LOCK);
    const overReleased = releaseScrollLock(releaseScrollLock(once));
    expect(overReleased.holders).toBe(0);
    expect(isScrollLocked(acquireScrollLock(overReleased))).toBe(true);
  });
});
