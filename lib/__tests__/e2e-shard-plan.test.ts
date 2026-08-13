import { describe, expect, it } from "vitest";
import {
  assertPartition,
  diffBuckets,
  isSpecFile,
  movedFiles,
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

describe("isSpecFile", () => {
  // The planner's universe is a directory walk filtered by this predicate, and
  // the partition guarantee needs that universe to be a SUPERSET of Playwright's
  // own resolution. So the predicate must admit everything Playwright's default
  // testMatch admits — being too GENEROUS is harmless (an extra file costs one
  // empty command-line entry), being too narrow drops specs onto no shard.
  // `scripts/e2e-shard-plan.ts --verify` checks the claim against the real
  // config; these pin the naming rule itself.
  it("admits every extension Playwright's default testMatch does", () => {
    for (const name of [
      "a.spec.ts",
      "a.spec.tsx",
      "a.spec.js",
      "a.spec.jsx",
      "a.spec.mts",
      "a.spec.cts",
      "a.spec.mjs",
      "a.spec.cjs",
      "a.test.ts",
      "a.test.js",
      "a.mobile.spec.ts",
    ]) {
      expect(isSpecFile(name), name).toBe(true);
    }
  });

  it("rejects the helper and fixture modules that sit beside the specs", () => {
    // These are real neighbours in e2e/ — planning one into a bucket would put a
    // file with no tests on a command line.
    for (const name of [
      "helpers.ts",
      "fixtures.ts",
      "seed-events.ts",
      "global-setup.ts",
      "spec-durations.json",
      "specs.ts",
      "a.spec.txt",
    ]) {
      expect(isSpecFile(name), name).toBe(false);
    }
  });
});

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

describe("co-residency diff", () => {
  // What a manifest refresh actually changes is WHICH SPECS CAN SHARE A DATABASE.
  // These pin the two reporting primitives; the generator composes them.
  const A = [
    ["a", "b"],
    ["c", "d"],
  ];

  it("reports nothing when the plan is unchanged", () => {
    expect(diffBuckets(A, A)).toEqual([]);
    expect(movedFiles(A, A)).toEqual([]);
  });

  it("names the shard a spec entered AND the one it left", () => {
    const B = [["a"], ["b", "c", "d"]];
    expect(diffBuckets(A, B)).toEqual([
      { shard: 1, entered: [], left: ["b"] },
      { shard: 2, entered: ["b"], left: [] },
    ]);
    expect(movedFiles(A, B)).toEqual([{ file: "b", from: 1, to: 2 }]);
  });

  it("does not report a NEW spec as moved — it had no neighbourhood to leave", () => {
    // It still shows as `entered` on its bucket (a resident DID gain a neighbour),
    // but it has not been reshuffled, so it is not a spec that "changed bucket".
    const withNew = [
      ["a", "b"],
      ["c", "d", "e"],
    ];
    expect(movedFiles(A, withNew)).toEqual([]);
    expect(diffBuckets(A, withNew)).toEqual([
      { shard: 2, entered: ["e"], left: [] },
    ]);
  });

  it("reports a deleted spec as leaving, and not as a move", () => {
    const deleted = [["a", "b"], ["c"]];
    expect(movedFiles(A, deleted)).toEqual([]);
    expect(diffBuckets(A, deleted)).toEqual([
      { shard: 2, entered: [], left: ["d"] },
    ]);
  });

  it("reports the tail when the shard COUNT itself changes", () => {
    // Re-splitting the suite renumbers nearly everything: `c` and `d` did not
    // change NEIGHBOURS at all — they are still exactly together — but their
    // shard is now 3. That is honest rather than noisy: the report answers "which
    // shard is this spec in now", and after a count change the answer really has
    // changed for almost every spec. Refresh the manifest and the shard count in
    // separate commits if you want a readable diff.
    const grown = [["a"], ["b"], ["c", "d"]];
    expect(movedFiles(A, grown)).toEqual([
      { file: "b", from: 1, to: 2 },
      { file: "c", from: 2, to: 3 },
      { file: "d", from: 2, to: 3 },
    ]);
    // Shard 3 is absent from `before` entirely — everything in it is new there.
    expect(diffBuckets(A, grown).at(-1)).toEqual({
      shard: 3,
      entered: ["c", "d"],
      left: [],
    });
  });
});
