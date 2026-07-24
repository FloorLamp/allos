import { describe, it, expect } from "vitest";
import {
  reconcileProduced,
  feedProducedDetail,
  detailReconciliationLine,
} from "@/lib/produced-count";

// The reconciliation between a document's extracted_count SNAPSHOT and its LIVE row
// count (#1339). One pure model both the Review feed and the import detail format,
// so a document that has shed rows can't read "7 items" on one surface and "produced
// no records" on the other.

describe("reconcileProduced", () => {
  it("is not drifted when live matches the snapshot", () => {
    const r = reconcileProduced(7, 7);
    expect(r).toEqual({ extracted: 7, live: 7, drifted: false, gone: 0 });
  });

  it("is drifted when rows have left (live < extracted)", () => {
    const r = reconcileProduced(7, 0);
    expect(r).toEqual({ extracted: 7, live: 0, drifted: true, gone: 7 });
  });

  it("reports the partial gone-count", () => {
    expect(reconcileProduced(33, 32)).toMatchObject({ drifted: true, gone: 1 });
  });

  it("clamps gone at 0 if live somehow exceeds extracted", () => {
    const r = reconcileProduced(3, 5);
    expect(r.drifted).toBe(false);
    expect(r.gone).toBe(0);
  });

  it("treats 0/0 as not drifted", () => {
    expect(reconcileProduced(0, 0)).toMatchObject({ drifted: false, gone: 0 });
  });
});

describe("feedProducedDetail", () => {
  it("shows the plain count when nothing drifted", () => {
    expect(feedProducedDetail(reconcileProduced(12, 12))).toEqual({
      detail: "12 items",
      muted: false,
    });
  });

  it("singularizes one item", () => {
    expect(feedProducedDetail(reconcileProduced(1, 1))).toEqual({
      detail: "1 item",
      muted: false,
    });
  });

  it("reads a done-but-empty (no drift) as muted 'no items'", () => {
    expect(feedProducedDetail(reconcileProduced(0, 0))).toEqual({
      detail: "no items",
      muted: true,
    });
  });

  it("shows 'live of extracted', muted, when fully drained", () => {
    expect(feedProducedDetail(reconcileProduced(7, 0))).toEqual({
      detail: "0 of 7 items",
      muted: true,
    });
  });

  it("shows 'live of extracted', not muted, when partially drifted", () => {
    expect(feedProducedDetail(reconcileProduced(33, 32))).toEqual({
      detail: "32 of 33 items",
      muted: false,
    });
  });
});

describe("detailReconciliationLine", () => {
  it("is null when nothing drifted (the normal copy stands)", () => {
    expect(detailReconciliationLine(reconcileProduced(7, 7))).toBeNull();
    expect(detailReconciliationLine(reconcileProduced(0, 0))).toBeNull();
  });

  it("names why the rows are gone when fully drained", () => {
    expect(detailReconciliationLine(reconcileProduced(7, 0))).toBe(
      "7 extracted · 0 remain (7 deleted, merged, or reassigned)"
    );
  });

  it("reconciles a partial drift", () => {
    expect(detailReconciliationLine(reconcileProduced(33, 32))).toBe(
      "33 extracted · 32 remain (1 deleted, merged, or reassigned)"
    );
  });
});
