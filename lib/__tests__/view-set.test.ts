import { describe, it, expect } from "vitest";
import {
  parseViewProfileIds,
  serializeViewProfileIds,
  toggleViewId,
} from "@/lib/view-set";

// Pure-tier coverage for the persisted view-set round-trip (lib/view-set.ts, issue
// #1096). The GRANT validation (∩ accessible) lives in resolveScope/auth and is
// exercised in the DB/action tiers; here we pin only the parse/serialize/toggle
// mechanics that a malformed or adversarial stored value must survive.

describe("parseViewProfileIds", () => {
  it("parses a JSON int array", () => {
    expect(parseViewProfileIds("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("maps null/undefined/empty to []", () => {
    expect(parseViewProfileIds(null)).toEqual([]);
    expect(parseViewProfileIds(undefined)).toEqual([]);
    expect(parseViewProfileIds("")).toEqual([]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseViewProfileIds("[2,1,2,1]")).toEqual([2, 1]);
  });

  it("drops non-integer, non-positive, and non-numeric members (never throws)", () => {
    expect(parseViewProfileIds('[1,"2",2.5,0,-3,null,3]')).toEqual([1, 3]);
  });

  it("degrades malformed JSON / non-arrays to [] rather than throwing", () => {
    expect(parseViewProfileIds("{not json")).toEqual([]);
    expect(parseViewProfileIds('{"a":1}')).toEqual([]);
    expect(parseViewProfileIds("5")).toEqual([]);
  });
});

describe("serializeViewProfileIds", () => {
  it("returns null for the single-view default (just the acting profile)", () => {
    expect(serializeViewProfileIds([7], 7)).toBeNull();
    expect(serializeViewProfileIds([], 7)).toBeNull();
  });

  it("serializes a genuine multi-view set", () => {
    expect(serializeViewProfileIds([7, 9], 7)).toBe("[7,9]");
  });

  it("cleans (de-dupes, drops junk) before serializing", () => {
    expect(serializeViewProfileIds([7, 7, 9, 0], 7)).toBe("[7,9]");
  });
});

describe("toggleViewId", () => {
  it("adds an absent id to the (defaulted) current set", () => {
    expect(toggleViewId([], 9, 7)).toEqual([7, 9]);
  });

  it("removes a present non-acting id", () => {
    expect(toggleViewId([7, 9], 9, 7)).toEqual([7]);
  });

  it("never removes the acting profile (toggling it is a no-op keeping it in view)", () => {
    expect(toggleViewId([7, 9], 7, 7)).toEqual([7, 9]);
    expect(toggleViewId([9], 7, 7)).toEqual([7, 9]);
  });

  it("does not mutate the input", () => {
    const current = [7, 9];
    toggleViewId(current, 9, 7);
    expect(current).toEqual([7, 9]);
  });
});
