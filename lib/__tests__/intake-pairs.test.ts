import { describe, it, expect } from "vitest";
import { orderIntakePair, separatePairWarnings } from "@/lib/intake-pairs";
import type { SupplementPair } from "@/lib/types";

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

// The "keep apart" bucket warning (issue #313): a `separate`-relation pair whose
// BOTH members have a due dose in the same time bucket raises a preformatted line.
describe("separatePairWarnings", () => {
  function pair(over: Partial<SupplementPair> = {}): SupplementPair {
    return {
      id: 1,
      a_id: 1,
      b_id: 2,
      relation: "separate",
      note: null,
      a_name: "Calcium",
      b_name: "Iron",
      ...over,
    };
  }

  it("warns when both members of a separate pair are in the bucket", () => {
    expect(separatePairWarnings([1, 2], [pair()])).toEqual([
      "Keep apart: Calcium and Iron",
    ]);
  });

  it("appends the note when present", () => {
    expect(
      separatePairWarnings([1, 2], [pair({ note: "space by 2h" })])
    ).toEqual(["Keep apart: Calcium and Iron — space by 2h"]);
  });

  it("stays silent when only one member is in the bucket", () => {
    expect(separatePairWarnings([1], [pair()])).toEqual([]);
    expect(separatePairWarnings([2], [pair()])).toEqual([]);
  });

  it("ignores non-separate (take-together) relations", () => {
    expect(separatePairWarnings([1, 2], [pair({ relation: "with" })])).toEqual(
      []
    );
  });

  it("returns one line per offending pair, in the pairs' order", () => {
    const pairs = [
      pair({ id: 1, a_id: 1, b_id: 2, a_name: "Calcium", b_name: "Iron" }),
      pair({ id: 2, a_id: 3, b_id: 4, a_name: "Zinc", b_name: "Copper" }),
    ];
    expect(separatePairWarnings([1, 2, 3, 4], pairs)).toEqual([
      "Keep apart: Calcium and Iron",
      "Keep apart: Zinc and Copper",
    ]);
  });

  it("accepts any iterable of ids (e.g. a Set)", () => {
    expect(separatePairWarnings(new Set([1, 2]), [pair()])).toEqual([
      "Keep apart: Calcium and Iron",
    ]);
  });
});
