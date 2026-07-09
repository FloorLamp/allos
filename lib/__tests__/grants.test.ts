import { describe, it, expect } from "vitest";
import { normalizeGrantSelection, diffGrants } from "../grants";

describe("normalizeGrantSelection", () => {
  it("keeps only valid, positive, integer, existing ids", () => {
    expect(normalizeGrantSelection([1, 2, 3, 99], [1, 2, 3])).toEqual([
      1, 2, 3,
    ]);
  });

  it("drops non-existent profile ids", () => {
    expect(normalizeGrantSelection([2, 5], [1, 2, 3])).toEqual([2]);
  });

  it("dedupes and sorts", () => {
    expect(normalizeGrantSelection([3, 1, 3, 1], [1, 2, 3])).toEqual([1, 3]);
  });

  it("rejects zero, negatives, and non-integers", () => {
    expect(normalizeGrantSelection([0, -1, 1.5, 2], [1, 2, 3])).toEqual([2]);
  });

  it("returns empty for an empty selection", () => {
    expect(normalizeGrantSelection([], [1, 2, 3])).toEqual([]);
  });
});

describe("diffGrants", () => {
  it("computes adds and removes", () => {
    expect(diffGrants([1, 2], [2, 3])).toEqual({ add: [3], remove: [1] });
  });

  it("is a no-op when unchanged", () => {
    expect(diffGrants([1, 2, 3], [3, 2, 1])).toEqual({ add: [], remove: [] });
  });

  it("adds all when starting from none", () => {
    expect(diffGrants([], [1, 2])).toEqual({ add: [1, 2], remove: [] });
  });

  it("removes all when clearing", () => {
    expect(diffGrants([1, 2], [])).toEqual({ add: [], remove: [1, 2] });
  });
});
