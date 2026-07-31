import { describe, it, expect } from "vitest";
import {
  PHONE_STACK,
  PHONE_STARRED_TILE_CAP,
  splitAtPhoneCap,
} from "../phone-fold";

describe("splitAtPhoneCap (#1578)", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("folds nothing when the list already fits", () => {
    expect(splitAtPhoneCap(["a", "b"], 3)).toEqual({
      shown: ["a", "b"],
      folded: [],
    });
    // Exactly at the cap is still a fit — an empty `folded` is the caller's signal
    // to draw no toggle at all.
    expect(splitAtPhoneCap(["a", "b", "c"], 3).folded).toEqual([]);
  });

  it("keeps the first `cap` in order and folds the rest, losing nothing", () => {
    const { shown, folded } = splitAtPhoneCap(items, 3);
    expect(shown).toEqual(["a", "b", "c"]);
    expect(folded).toEqual(["d", "e"]);
    expect([...shown, ...folded]).toEqual(items);
  });

  it("does not mutate or alias its input", () => {
    const source = [...items];
    const { shown } = splitAtPhoneCap(source, 3);
    shown.push("z");
    expect(source).toEqual(items);
  });

  it("caps starred tiles at a number that fills the widest grid row", () => {
    // Three is the `lg:grid-cols-3` row width, so the phone cap is not an arbitrary
    // phone-only invention.
    expect(PHONE_STARRED_TILE_CAP).toBe(3);
  });
});

// The phone reading order of Results › Biomarkers (#1647). These are class strings,
// not a computation — so what is worth holding is the two invariants that make them
// safe: the order is a total, gap-free ranking (no two slots can tie into an
// ambiguous stack, no rank is skipped), and EVERY slot resets at `sm` so desktop
// keeps rendering in DOM order. A fifth slot added without `sm:order-none` would
// silently re-order the desktop page, which is the one thing this change promises
// not to do.
describe("PHONE_STACK (#1647)", () => {
  const slots = ["warning", "index", "glance", "entry"] as const;

  it("ranks the four slots 1..4 with the index above both glance cards", () => {
    const rank = (s: (typeof slots)[number]) =>
      Number(/(?:^|\s)order-(\d+)(?:\s|$)/.exec(PHONE_STACK[s])?.[1]);
    const ranks = slots.map(rank);
    expect(ranks.some(Number.isNaN)).toBe(false);
    // Total and gap-free: exactly 1..N, each once.
    expect([...ranks].sort()).toEqual([1, 2, 3, 4]);
    // The point of the change: the index outranks the glance cards, and the warning
    // outranks the index.
    expect(rank("warning")).toBeLessThan(rank("index"));
    expect(rank("index")).toBeLessThan(rank("glance"));
    expect(rank("glance")).toBeLessThan(rank("entry"));
  });

  it("resets every slot at `sm`, so desktop renders in DOM order", () => {
    for (const s of slots) expect(PHONE_STACK[s]).toContain("sm:order-none");
  });

  it("gives every slot `min-w-0` and the container no flex gap", () => {
    // A flex item defaults to min-width:auto, which would let the wide biomarkers
    // table push the column past a 390px viewport instead of scrolling in its own
    // frame.
    for (const s of slots) expect(PHONE_STACK[s]).toContain("min-w-0");
    expect(PHONE_STACK.container).toContain("flex-col");
    // No `gap-*`: three slots render nothing for some profiles, and a gap would draw
    // a phantom band where an empty card would have been. The cards' own `mb-6`
    // spaces them.
    expect(PHONE_STACK.container).not.toMatch(/(?:^|\s)gap-/);
  });
});
