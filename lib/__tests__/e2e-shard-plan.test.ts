import { describe, expect, it } from "vitest";
import {
  assertPartition,
  planShards,
  type DurationMap,
} from "@/lib/e2e-shard-plan";

// The property that matters is the PARTITION, not the balance: an unbalanced
// suite is slow, a lossy one is green while running nothing. Balance is asserted
// too, but only as "beats the count-based split it replaces".

const files = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `e2e/spec-${String(i).padStart(3, "0")}.spec.ts`
  );

describe("planShards", () => {
  it("assigns every spec file to exactly one shard", () => {
    const list = files(97);
    const durations: DurationMap = Object.fromEntries(
      list.map((f, i) => [f, (i % 17) + 1])
    );
    const plan = planShards(list, durations, 12);
    expect(plan.buckets.flat().sort()).toEqual([...list].sort());
    expect(plan.buckets.flat()).toHaveLength(list.length);
  });

  it("is deterministic, so shards planning independently agree", () => {
    const list = files(60);
    const durations: DurationMap = Object.fromEntries(
      list.map((f, i) => [f, ((i * 7) % 23) + 1])
    );
    const a = planShards(list, durations, 8);
    const b = planShards([...list].reverse(), durations, 8);
    expect(b.buckets).toEqual(a.buckets);
  });

  it("beats a count-based split on the metric that decides the wait", () => {
    // One file dominates, exactly the patient-portals-setup shape.
    const list = files(24);
    const durations: DurationMap = Object.fromEntries(
      list.map((f, i) => [f, i === 0 ? 55 : 5])
    );
    const plan = planShards(list, durations, 4);
    const byCount = [0, 1, 2, 3].map((s) =>
      list.filter((_, i) => i % 4 === s).reduce((n, f) => n + durations[f], 0)
    );
    expect(Math.max(...plan.loads)).toBeLessThan(Math.max(...byCount));
    // The largest single file is the floor — a file cannot be split.
    expect(Math.max(...plan.loads)).toBeGreaterThanOrEqual(55);
  });

  it("still places a file that has no recorded duration", () => {
    const list = [...files(10), "e2e/brand-new.spec.ts"];
    const durations: DurationMap = Object.fromEntries(
      files(10).map((f) => [f, 4])
    );
    const plan = planShards(list, durations, 3);
    expect(plan.buckets.flat()).toContain("e2e/brand-new.spec.ts");
    expect(plan.unknown).toEqual(["e2e/brand-new.spec.ts"]);
    expect(plan.coverage).toBeCloseTo(10 / 11);
  });

  it("degrades to an even split when the manifest is missing entirely", () => {
    const list = files(12);
    const plan = planShards(list, {}, 4);
    expect(plan.coverage).toBe(0);
    expect(plan.buckets.every((b) => b.length === 3)).toBe(true);
  });

  it("tolerates more shards than spec files", () => {
    const plan = planShards(files(2), { "e2e/spec-000.spec.ts": 3 }, 5);
    expect(plan.buckets.flat().sort()).toEqual(files(2));
    expect(plan.buckets.filter((b) => b.length === 0)).toHaveLength(3);
  });

  it("refuses a duplicated input rather than running a spec twice", () => {
    const dup = ["e2e/a.spec.ts", "e2e/a.spec.ts"];
    expect(() => planShards(dup, {}, 2)).toThrow(/duplicate/i);
  });

  it("rejects a nonsense shard count", () => {
    expect(() => planShards(files(3), {}, 0)).toThrow(/positive integer/);
  });
});

describe("assertPartition", () => {
  it("fails a plan that would never run a spec", () => {
    expect(() => assertPartition(["a", "b", "c"], [["a"], ["b"]])).toThrow(
      /never run/
    );
  });

  it("fails a plan that runs a spec on two shards", () => {
    expect(() => assertPartition(["a", "b"], [["a", "b"], ["b"]])).toThrow(
      /more than one shard/
    );
  });

  it("fails a plan naming a spec that is not in the suite", () => {
    expect(() => assertPartition(["a"], [["a"], ["ghost"]])).toThrow(
      /unknown file/
    );
  });

  it("accepts an exact partition", () => {
    expect(() =>
      assertPartition(["a", "b", "c"], [["c"], ["a"], ["b"]])
    ).not.toThrow();
  });
});
