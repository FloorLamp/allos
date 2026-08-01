// Bulk corrections (issue #1603) — the pure planner. Covers the closed op set
// (offset / factor / set), the unit presets (lb→kg, mi→km — just multiplies wired
// to the existing boundary constants), integer rounding, out-of-range refusal,
// no-op exclusion, the empty plan, the CAS signature, and the deleted_rows
// payload round-trip.

import { describe, expect, it } from "vitest";
import {
  CORRECTION_FIELDS,
  bulkCorrectionLabel,
  correctionSignature,
  formatCorrectionValue,
  isCorrectionFieldId,
  parseBulkCorrectionPayload,
  planCorrection,
  resolveCorrectionOp,
  serializeBulkCorrectionPayload,
  type CorrectionRow,
} from "@/lib/bulk-correction";
import { LB_PER_KG, MI_PER_KM } from "@/lib/units";

const METRIC_UNITS = { weightUnit: "kg", distanceUnit: "km" } as const;
const IMPERIAL_UNITS = { weightUnit: "lb", distanceUnit: "mi" } as const;

function rows(...values: number[]): CorrectionRow[] {
  return values.map((value, i) => ({ id: i + 1, value }));
}

describe("planCorrection", () => {
  it("adds an offset to every row", () => {
    const plan = planCorrection("weight", rows(80, 81.5), {
      kind: "add",
      amount: -1.5,
    });
    expect(plan).toMatchObject({ ok: true, unchanged: 0 });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.changes).toEqual([
      { id: 1, field: "weight", before: 80, after: 78.5 },
      { id: 2, field: "weight", before: 81.5, after: 80 },
    ]);
    expect(plan.summary).toEqual({
      count: 2,
      beforeMin: 80,
      beforeMax: 81.5,
      afterMin: 78.5,
      afterMax: 80,
    });
  });

  it("multiplies by a factor, rounding away float noise", () => {
    const plan = planCorrection("weight", rows(176.4), {
      kind: "multiply",
      factor: 1 / LB_PER_KG,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.changes[0].after).toBeCloseTo(80.014, 3);
    // Canonical rounding: at most 6 decimals ever reach storage.
    expect(plan.changes[0].after).toBe(
      Math.round((176.4 / LB_PER_KG) * 1e6) / 1e6
    );
  });

  it("sets every row to one value, counting already-correct rows as unchanged", () => {
    const plan = planCorrection("body-fat", rows(24, 22, 24), {
      kind: "set",
      value: 24,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.changes).toEqual([
      { id: 2, field: "body-fat", before: 22, after: 24 },
    ]);
    expect(plan.unchanged).toBe(2);
  });

  it("rounds whole-number fields (resting HR) to integers", () => {
    const plan = planCorrection("resting-hr", rows(55), {
      kind: "multiply",
      factor: 1.1,
    });
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.changes[0].after).toBe(61);
  });

  it("returns an empty plan for no rows and for an all-no-op transform", () => {
    const none = planCorrection("weight", [], { kind: "add", amount: 2 });
    if (!none.ok) throw new Error("unreachable");
    expect(none.changes).toEqual([]);
    expect(none.summary).toBeNull();

    const noop = planCorrection("weight", rows(80, 81), {
      kind: "multiply",
      factor: 1,
    });
    if (!noop.ok) throw new Error("unreachable");
    expect(noop.changes).toEqual([]);
    expect(noop.unchanged).toBe(2);
  });

  it("refuses the WHOLE plan when any result leaves the field's domain", () => {
    // One row would go negative — nothing is planned, the count says how many.
    expect(
      planCorrection("weight", rows(80, 3), { kind: "add", amount: -5 })
    ).toEqual({ ok: false, error: "out-of-range", count: 1 });
    // Body fat has an upper bound too.
    expect(
      planCorrection("body-fat", rows(60, 20), { kind: "multiply", factor: 2 })
    ).toEqual({ ok: false, error: "out-of-range", count: 1 });
  });
});

describe("resolveCorrectionOp", () => {
  it("converts add/set amounts at the unit boundary (lb login)", () => {
    const add = resolveCorrectionOp(
      "weight",
      { kind: "add", value: 2 },
      IMPERIAL_UNITS
    );
    expect(add).toEqual({ kind: "add", amount: 2 / LB_PER_KG });
    const set = resolveCorrectionOp(
      "distance",
      { kind: "set", value: 3.1 },
      IMPERIAL_UNITS
    );
    expect(set).toEqual({ kind: "set", value: 3.1 / MI_PER_KM });
    // Unit-free fields pass through untouched regardless of prefs.
    expect(
      resolveCorrectionOp("hrv", { kind: "add", value: 5 }, IMPERIAL_UNITS)
    ).toEqual({ kind: "add", amount: 5 });
  });

  it("compiles the unit preset to the field's registered multiply", () => {
    expect(
      resolveCorrectionOp("weight", { kind: "unit-preset" }, METRIC_UNITS)
    ).toEqual({ kind: "multiply", factor: 1 / LB_PER_KG });
    expect(
      resolveCorrectionOp("distance", { kind: "unit-preset" }, METRIC_UNITS)
    ).toEqual({ kind: "multiply", factor: 1 / MI_PER_KM });
    // A field without a preset refuses rather than guessing.
    expect(
      resolveCorrectionOp("body-fat", { kind: "unit-preset" }, METRIC_UNITS)
    ).toBeNull();
  });

  it("refuses malformed ops", () => {
    expect(
      resolveCorrectionOp("weight", { kind: "add", value: 0 }, METRIC_UNITS)
    ).toBeNull();
    expect(
      resolveCorrectionOp(
        "weight",
        { kind: "multiply", value: 0 },
        METRIC_UNITS
      )
    ).toBeNull();
    expect(
      resolveCorrectionOp(
        "weight",
        { kind: "multiply", value: -2 },
        METRIC_UNITS
      )
    ).toBeNull();
    expect(
      resolveCorrectionOp("weight", { kind: "set", value: -1 }, METRIC_UNITS)
    ).toBeNull();
    expect(
      resolveCorrectionOp("weight", { kind: "set", value: NaN }, METRIC_UNITS)
    ).toBeNull();
    expect(
      resolveCorrectionOp("weight", { kind: "add" }, METRIC_UNITS)
    ).toBeNull();
  });
});

describe("correctionSignature", () => {
  const changes = [
    { id: 1, before: 80 },
    { id: 2, before: 81.5 },
  ];

  it("is deterministic for the same (id, before) pairs", () => {
    expect(correctionSignature(changes)).toBe(
      correctionSignature([...changes])
    );
  });

  it("changes when any id, value, or the row count drifts", () => {
    const base = correctionSignature(changes);
    expect(correctionSignature([{ id: 1, before: 80 }])).not.toBe(base);
    expect(
      correctionSignature([
        { id: 1, before: 80 },
        { id: 3, before: 81.5 },
      ])
    ).not.toBe(base);
    expect(
      correctionSignature([
        { id: 1, before: 80 },
        { id: 2, before: 81.6 },
      ])
    ).not.toBe(base);
  });
});

describe("payload round-trip", () => {
  it("serializes and parses the inverse snapshot", () => {
    const json = serializeBulkCorrectionPayload("weight", [
      { id: 7, before: 176.4, after: 80.014, lockSet: true },
      { id: 9, before: 170, after: 77.1, lockSet: false },
    ]);
    const parsed = parseBulkCorrectionPayload(json);
    expect(parsed).toEqual({
      v: 1,
      kind: "bulk-correction",
      field: "weight",
      changes: [
        { id: 7, before: 176.4, after: 80.014, lockSet: true },
        { id: 9, before: 170, after: 77.1, lockSet: false },
      ],
    });
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(parseBulkCorrectionPayload("not json")).toBeNull();
    expect(parseBulkCorrectionPayload(`{"v":1,"kind":"activity"}`)).toBeNull();
    expect(
      parseBulkCorrectionPayload(
        `{"v":1,"kind":"bulk-correction","field":"weight","changes":[{"id":1}]}`
      )
    ).toBeNull();
  });
});

describe("labels and formatting", () => {
  it("builds the non-PHI deleted_rows label from the registry", () => {
    expect(bulkCorrectionLabel("weight", 92)).toBe(
      "body_metrics · weight_kg · 92 rows"
    );
    expect(bulkCorrectionLabel("hrv", 1)).toBe(
      "metric_samples · value · 1 row"
    );
  });

  it("formats canonical values in the login's display unit", () => {
    expect(formatCorrectionValue("weight", 80, METRIC_UNITS)).toBe("80 kg");
    expect(formatCorrectionValue("weight", 80, IMPERIAL_UNITS)).toBe(
      `${Math.round(80 * LB_PER_KG * 10) / 10} lb`
    );
    expect(formatCorrectionValue("distance", 5, IMPERIAL_UNITS)).toBe(
      `${Math.round(5 * MI_PER_KM * 100) / 100} mi`
    );
    expect(formatCorrectionValue("resting-hr", 55, METRIC_UNITS)).toBe(
      "55 bpm"
    );
  });

  it("guards the field-id vocabulary", () => {
    expect(isCorrectionFieldId("weight")).toBe(true);
    expect(isCorrectionFieldId("medical-records")).toBe(false);
    expect(isCorrectionFieldId(undefined)).toBe(false);
    // Every registry entry agrees with its key (the id is the identity).
    for (const [key, spec] of Object.entries(CORRECTION_FIELDS)) {
      expect(spec.id).toBe(key);
    }
  });
});
