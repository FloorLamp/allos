import { describe, expect, it } from "vitest";
import { computeFlagReconciliation } from "../flag-reconcile";

// The shared per-row decision behind queries.reconcileFlags and the boot-time
// reconcileNonOptimalFlags in lib/db.ts. reconciledFlag's own semantics are
// covered in reference-range.test; this locks the wrapper: case-insensitive cb
// lookup, dropping "no change" (undefined) rows, and mapping a clear to flag=null.
const cb = {
  name: "X",
  unit: "u",
  ref_low: 4,
  ref_high: 6,
  direction: "in_range" as const,
  optimal_low: null,
  optimal_high: null,
  optimal_low_male: null,
  optimal_high_male: null,
  optimal_low_female: null,
  optimal_high_female: null,
};
const cbByName = new Map([["x", cb]]);

describe("computeFlagReconciliation", () => {
  it("emits a set for an out-of-range value the lab did not flag", () => {
    const changes = computeFlagReconciliation(
      [{ id: 1, value_num: 2, unit: "u", canonical_name: "X", flag: null }],
      cbByName,
      null
    );
    expect(changes).toEqual([{ id: 1, flag: "low" }]);
  });

  it("emits a clear (flag=null) for a stale flag inside the range", () => {
    const changes = computeFlagReconciliation(
      [{ id: 2, value_num: 5, unit: "u", canonical_name: "X", flag: "low" }],
      cbByName,
      null
    );
    expect(changes).toEqual([{ id: 2, flag: null }]);
  });

  it("omits rows the reconcile leaves unchanged", () => {
    const changes = computeFlagReconciliation(
      [{ id: 3, value_num: 2, unit: "u", canonical_name: "X", flag: "low" }],
      cbByName,
      null
    );
    expect(changes).toEqual([]);
  });

  it("looks up the canonical map case-insensitively", () => {
    const changes = computeFlagReconciliation(
      [{ id: 4, value_num: 2, unit: "u", canonical_name: "x", flag: null }],
      cbByName,
      null
    );
    expect(changes).toEqual([{ id: 4, flag: "low" }]);
  });

  it("omits rows whose canonical name has no reference entry", () => {
    const changes = computeFlagReconciliation(
      [
        {
          id: 5,
          value_num: 2,
          unit: "u",
          canonical_name: "Unknown",
          flag: null,
        },
      ],
      cbByName,
      null
    );
    expect(changes).toEqual([]);
  });

  it("returns one change per affected row (count-preserving)", () => {
    const changes = computeFlagReconciliation(
      [
        { id: 1, value_num: 2, unit: "u", canonical_name: "X", flag: null }, // set low
        { id: 2, value_num: 5, unit: "u", canonical_name: "X", flag: "low" }, // clear
        { id: 3, value_num: 5, unit: "u", canonical_name: "X", flag: null }, // unchanged
      ],
      cbByName,
      null
    );
    expect(changes).toHaveLength(2);
  });

  // Age-banded marker: adult range 40–129, childhood band (1–10) 140–420.
  const alp = {
    name: "ALP",
    unit: "U/L",
    ref_low: 40,
    ref_high: 129,
    direction: "in_range" as const,
    optimal_low: null,
    optimal_high: null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
    ranges_by_age: [{ min_age: 1, max_age: 10, ref_low: 140, ref_high: 420 }],
  };
  const alpByName = new Map([["alp", alp]]);

  it("judges each row against the subject's age ON ITS OWN date", () => {
    const rows = [
      // Collected when the subject was ~5 (born 2015): 300 is in the child band.
      {
        id: 1,
        value_num: 300,
        unit: "U/L",
        canonical_name: "ALP",
        flag: "high",
        date: "2020-06-01",
      },
      // Collected at ~35: 300 is above the adult range.
      {
        id: 2,
        value_num: 300,
        unit: "U/L",
        canonical_name: "ALP",
        flag: null,
        date: "2050-06-01",
      },
    ];
    const changes = computeFlagReconciliation(rows, alpByName, {
      sex: null,
      birthdate: "2015-01-01",
    });
    // Row 1: stale 'high' cleared (in the child band); row 2: set 'high' (adult).
    expect(changes).toEqual([
      { id: 1, flag: null },
      { id: 2, flag: "high" },
    ]);
  });

  it("falls back to the adult band when no age context is given", () => {
    const changes = computeFlagReconciliation(
      [
        {
          id: 1,
          value_num: 300,
          unit: "U/L",
          canonical_name: "ALP",
          flag: null,
          date: "2020-06-01",
        },
      ],
      alpByName,
      null
    );
    expect(changes).toEqual([{ id: 1, flag: "high" }]);
  });

  // Reproductive-status threading: a hormone entry with a postmenopausal
  // status range that's tighter than the reproductive-age envelope.
  const e2 = {
    name: "Estradiol",
    unit: "pg/mL",
    ref_low: null,
    ref_high: 400,
    ref_low_female: null,
    ref_high_female: 400,
    direction: "in_range" as const,
    optimal_low: null,
    optimal_high: null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
    ranges_by_status: {
      premenopausal: { ref_low: null, ref_high: 400 },
      postmenopausal: { ref_low: null, ref_high: 30 },
    },
  };
  const e2ByName = new Map([["estradiol", e2]]);

  it("threads reproductiveStatus into the reconcile (postmenopausal flags a high E2)", () => {
    const row = [
      {
        id: 1,
        value_num: 200,
        unit: "pg/mL",
        canonical_name: "Estradiol",
        flag: null,
        date: "2024-01-01",
      },
    ];
    // With postmenopausal status the ≤30 ceiling flags 200 as high.
    expect(
      computeFlagReconciliation(row, e2ByName, {
        sex: "female",
        reproductiveStatus: "postmenopausal",
      })
    ).toEqual([{ id: 1, flag: "high" }]);
    // Unset status → reproductive-age envelope (≤400) → no flag (unchanged).
    expect(computeFlagReconciliation(row, e2ByName, { sex: "female" })).toEqual(
      []
    );
  });
});
