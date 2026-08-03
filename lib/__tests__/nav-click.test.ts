import { describe, it, expect } from "vitest";
import { isDuplicateNavClick, type NavClickIntent } from "@/lib/nav-click";

const plain = (over: Partial<NavClickIntent> = {}): NavClickIntent => ({
  pending: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
  target: null,
  ...over,
});

describe("isDuplicateNavClick", () => {
  it("lets the first click through", () => {
    expect(isDuplicateNavClick(plain())).toBe(false);
  });

  it("drops a repeat plain click while the link's navigation is pending", () => {
    expect(isDuplicateNavClick(plain({ pending: true }))).toBe(true);
  });

  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    it(`keeps ${key}-click working while pending — it opens a new tab or window, it does not re-navigate here`, () => {
      expect(isDuplicateNavClick(plain({ pending: true, [key]: true }))).toBe(
        false
      );
    });
  }

  it("keeps middle-click working while pending", () => {
    expect(isDuplicateNavClick(plain({ pending: true, button: 1 }))).toBe(
      false
    );
  });

  it("keeps a targeted anchor working while pending", () => {
    expect(
      isDuplicateNavClick(plain({ pending: true, target: "_blank" }))
    ).toBe(false);
  });

  it("treats target=_self as this document, so a repeat click there is still a duplicate", () => {
    expect(isDuplicateNavClick(plain({ pending: true, target: "_self" }))).toBe(
      true
    );
  });

  it("never suppresses anything while nothing is pending, however the click is modified", () => {
    expect(
      isDuplicateNavClick(
        plain({ metaKey: true, shiftKey: true, button: 1, target: "_blank" })
      )
    ).toBe(false);
  });
});
