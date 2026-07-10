import { describe, it, expect } from "vitest";
import { orderIntakePair } from "@/lib/intake-pairs";

// The single write-path normalizer behind intake_item_pairs' canonical ordering
// (issue #97): a "take together / keep apart" pair is direction-independent and is
// stored a_id < b_id (enforced by CHECK (a_id < b_id) + UNIQUE(a_id,b_id,relation)).
describe("orderIntakePair", () => {
  it("returns ascending order regardless of argument order", () => {
    expect(orderIntakePair(3, 7)).toEqual([3, 7]);
    expect(orderIntakePair(7, 3)).toEqual([3, 7]);
  });

  it("is idempotent — ordering an ordered pair is a no-op", () => {
    const once = orderIntakePair(9, 2);
    expect(orderIntakePair(once[0], once[1])).toEqual([2, 9]);
  });

  it("normalizes both directions to the same canonical pair", () => {
    expect(orderIntakePair(4, 8)).toEqual(orderIntakePair(8, 4));
  });
});
