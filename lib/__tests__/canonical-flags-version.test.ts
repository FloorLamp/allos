import { describe, expect, it } from "vitest";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";

const base = [
  {
    name: "ALT",
    unit: "U/L",
    direction: "lower_better",
    ref_high: 44,
    optimal_high: 30,
    note: "some note",
  },
  {
    name: "Testosterone, Total",
    unit: "ng/dL",
    direction: "in_range",
    ref_low_male: 264,
    ref_high_male: 916,
    ref_low_female: 8,
    ref_high_female: 60,
  },
];

describe("canonicalFlagsSignature", () => {
  it("is deterministic and order-independent", () => {
    const a = canonicalFlagsSignature(base);
    const b = canonicalFlagsSignature([base[1], base[0]]);
    expect(a).toBe(b);
  });

  it("changes when a flag-relevant range changes", () => {
    const before = canonicalFlagsSignature(base);
    const after = canonicalFlagsSignature([
      { ...base[0], ref_high: 45 },
      base[1],
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a sex-specific range changes", () => {
    const before = canonicalFlagsSignature(base);
    const after = canonicalFlagsSignature([
      base[0],
      { ...base[1], ref_high_female: 70 },
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when an age band (ranges_by_age) changes", () => {
    const before = canonicalFlagsSignature(base);
    const after = canonicalFlagsSignature([
      {
        ...base[0],
        ranges_by_age: [{ min_age: 1, max_age: 10, ref_high: 420 }],
      },
      base[1],
    ]);
    expect(after).not.toBe(before);
  });

  it("ignores cosmetic fields like note and category", () => {
    const before = canonicalFlagsSignature(base);
    const after = canonicalFlagsSignature([
      { ...base[0], note: "different note", category: "lab" },
      base[1],
    ]);
    expect(after).toBe(before);
  });

  it("changes when the logic version is bumped", () => {
    expect(canonicalFlagsSignature(base, 1)).not.toBe(
      canonicalFlagsSignature(base, 2)
    );
  });
});
