import { describe, it, expect } from "vitest";
import { PHONE_STARRED_TILE_CAP, splitAtPhoneCap } from "../phone-fold";

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
