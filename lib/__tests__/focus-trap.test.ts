// Pure-tier coverage for the ConfirmDialog modal Tab focus trap (#832). The
// component wiring (querying focusables, reading document.activeElement, calling
// .focus()) is DOM-behavioral, but the WRAP DECISION — where Tab/Shift+Tab should
// send focus at the dialog edges, and how escaped focus is pulled back — is the pure
// nextTrapFocusIndex, tested here so a regression that breaks the trap (Tab escaping
// to the inert background, no wrap at the edges) fails the build.

import { describe, expect, it } from "vitest";
import { nextTrapFocusIndex } from "@/lib/focus-trap";

describe("nextTrapFocusIndex — modal Tab trap wrap decision", () => {
  // A 3-element dialog (Cancel, Confirm, +1) with focus somewhere inside it.
  const inside = (activeIndex: number, shift: boolean) =>
    nextTrapFocusIndex(3, activeIndex, true, shift);

  it("Tab off the LAST element wraps to the first", () => {
    expect(inside(2, false)).toBe(0);
  });

  it("Shift+Tab off the FIRST element wraps to the last", () => {
    expect(inside(0, true)).toBe(2);
  });

  it("Tab mid-list stays put (browser handles native order)", () => {
    expect(inside(0, false)).toBeNull();
    expect(inside(1, false)).toBeNull();
  });

  it("Shift+Tab mid-list stays put", () => {
    expect(inside(1, true)).toBeNull();
    expect(inside(2, true)).toBeNull();
  });

  it("focus that ESCAPED the dialog is pulled back to an edge", () => {
    // activeInsideRoot false ⇒ wrap regardless of activeIndex.
    expect(nextTrapFocusIndex(3, -1, false, false)).toBe(0); // Tab → first
    expect(nextTrapFocusIndex(3, -1, false, true)).toBe(2); // Shift+Tab → last
  });

  it("focus on the dialog container (inside root, not a focusable) is NOT force-moved", () => {
    // activeIndex -1 but still inside root ⇒ let the native Tab move into the list.
    expect(nextTrapFocusIndex(3, -1, true, false)).toBeNull();
    expect(nextTrapFocusIndex(3, -1, true, true)).toBeNull();
  });

  it("a single-focusable dialog wraps to itself in both directions", () => {
    expect(nextTrapFocusIndex(1, 0, true, false)).toBe(0);
    expect(nextTrapFocusIndex(1, 0, true, true)).toBe(0);
  });

  it("an EMPTY dialog (zero focusables) never moves focus — no crash", () => {
    expect(nextTrapFocusIndex(0, -1, true, false)).toBeNull();
    expect(nextTrapFocusIndex(0, -1, false, true)).toBeNull();
  });
});
