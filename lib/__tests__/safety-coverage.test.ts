import { describe, expect, it } from "vitest";
import {
  stackScreeningCoverage,
  coverageScopeLine,
  type CoverageItem,
} from "@/lib/safety-coverage";

// Pure-tier pins for the #1032 screening-coverage summarizer: the scope-line model
// over a stack — an all-off-dataset stack reads "0 of M", a fully-resolved clean
// stack "M of M, no flags" — plus the honest-empty copy discipline (absence of a
// flag never reads as clearance).

function item(over: Partial<CoverageItem> = {}): CoverageItem {
  return { name: "Sertraline 50 mg", rxcui: "36437", active: true, ...over };
}

describe("stackScreeningCoverage (#1032)", () => {
  it("an all-off-dataset stack yields 0 of M matched", () => {
    const m = stackScreeningCoverage([
      item({ name: "Loratadine 10 mg", rxcui: null }),
      item({ name: "Cetirizine", rxcui: null }),
    ]);
    expect(m).toEqual({ total: 2, matched: 0, unresolved: 2 });
  });

  it("a fully-resolved matching stack yields M of M matched, none unresolved", () => {
    const m = stackScreeningCoverage([
      item({ name: "Sertraline 50 mg", rxcui: "36437" }),
      item({ name: "Warfarin 5 mg", rxcui: "11289" }),
    ]);
    expect(m.total).toBe(2);
    expect(m.matched).toBe(2);
    expect(m.unresolved).toBe(0);
  });

  it("a name-only item still matches by synonym but counts as unresolved (degraded coverage)", () => {
    const m = stackScreeningCoverage([
      item({ name: "Sertraline", rxcui: null }),
    ]);
    expect(m).toEqual({ total: 1, matched: 1, unresolved: 1 });
  });

  it("inactive items are out of the screened stack (the detector drops them too)", () => {
    const m = stackScreeningCoverage([
      item({ active: false }),
      item({ name: "Loratadine", rxcui: null }),
    ]);
    expect(m.total).toBe(1);
  });
});

describe("coverageScopeLine (#1032)", () => {
  it("names the scope + fraction, and an empty result says no flags WITHOUT claiming clearance", () => {
    const line = coverageScopeLine(
      { total: 3, matched: 1, unresolved: 0 },
      true
    )!;
    expect(line).toContain("curated set");
    expect(line).toContain("1 of 3 active items");
    expect(line).toContain("No flags found");
    expect(line).toContain("not an exhaustive one");
  });

  it("with flags showing, the line states the scope but no 'no flags' claim", () => {
    const line = coverageScopeLine(
      { total: 2, matched: 2, unresolved: 0 },
      false
    )!;
    expect(line).toContain("2 of 2 active items");
    expect(line).not.toContain("No flags found");
  });

  it("calls out unresolved (name-only) items as name-only screening", () => {
    expect(
      coverageScopeLine({ total: 2, matched: 1, unresolved: 1 }, true)
    ).toContain("1 item has no confirmed RxNorm code");
    expect(
      coverageScopeLine({ total: 3, matched: 1, unresolved: 2 }, true)
    ).toContain("2 items have no confirmed RxNorm code");
  });

  it("an empty stack yields no line (claiming a check ran would be dishonest)", () => {
    expect(
      coverageScopeLine({ total: 0, matched: 0, unresolved: 0 }, true)
    ).toBeNull();
  });
});
