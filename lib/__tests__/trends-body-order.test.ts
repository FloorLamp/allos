import { describe, expect, it } from "vitest";
import {
  orderBodyCharts,
  type BodyChartDescriptor,
} from "@/lib/trends-body-order";

// #1067 Phase 1: the Body tab's synced charts order by relevance — present + recent
// ahead of the fixed order — and the SAME visible list drives both the chart cards
// and the sticky jump chips (one predicate, no drift).

function d(over: Partial<BodyChartDescriptor>): BodyChartDescriptor {
  return {
    id: over.id ?? "x",
    label: over.label ?? "X",
    present: over.present ?? true,
    latestDate: over.latestDate ?? null,
    order: over.order ?? 0,
  };
}

describe("orderBodyCharts", () => {
  it("drops chartless (absent) metrics entirely", () => {
    const out = orderBodyCharts([
      d({ id: "steps", present: true, latestDate: "2026-01-01", order: 0 }),
      d({ id: "bmr", present: false, latestDate: "2026-06-01", order: 1 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["steps"]);
  });

  it("orders more-recent data ahead of the fixed base order", () => {
    // steps is earlier in the base order but its data is stale; hr updated today.
    const out = orderBodyCharts([
      d({ id: "steps", latestDate: "2026-01-01", order: 0 }),
      d({ id: "hr", latestDate: "2026-06-20", order: 2 }),
      d({ id: "bmi", latestDate: "2026-03-01", order: 4 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["hr", "bmi", "steps"]);
  });

  it("breaks recency ties by the fixed base order", () => {
    const out = orderBodyCharts([
      d({ id: "b", latestDate: "2026-06-01", order: 3 }),
      d({ id: "a", latestDate: "2026-06-01", order: 1 }),
      d({ id: "c", latestDate: "2026-06-01", order: 2 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts present-but-undated (null latestDate) entries last, then by base order", () => {
    const out = orderBodyCharts([
      d({ id: "undated2", latestDate: null, order: 5 }),
      d({ id: "dated", latestDate: "2026-01-01", order: 9 }),
      d({ id: "undated1", latestDate: null, order: 1 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["dated", "undated1", "undated2"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      d({ id: "a", latestDate: "2026-01-01", order: 0 }),
      d({ id: "b", latestDate: "2026-06-01", order: 1 }),
    ];
    const snapshot = input.map((e) => e.id);
    orderBodyCharts(input);
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});
