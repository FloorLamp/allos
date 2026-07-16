import { describe, expect, it } from "vitest";
import {
  DATASET_SCHEMA,
  DatasetError,
  loadDataset,
  createMatcher,
  nameStrategy,
  slugStrategy,
  fieldStrategy,
  rxcuiStrategyStub,
  citationPresent,
  identityResolves,
  refusalGate,
  runHarness,
  type DatasetEnvelope,
} from "@/lib/datasets";

// Unit tests for the curated-dataset framework core (issue #860 Track B): the loader's
// contract enforcement, the matcher strategies + refusal gate, and the harness
// assertions — all over synthetic fixtures. Pure — no DB, no network.

interface Food {
  slug: string;
  name: string;
  kcal: number;
}

function validEnvelope(): DatasetEnvelope<Food> {
  return {
    $schema: DATASET_SCHEMA,
    id: "foods",
    title: "Test foods",
    citation: [{ source: "A cited source" }],
    identity: { keys: ["slug", "name"] },
    entries: [
      { slug: "fatty_fish", name: "Fatty Fish", kcal: 200 },
      { slug: "oats", name: "Oats", kcal: 150 },
    ],
  };
}

describe("loadDataset", () => {
  it("accepts a valid envelope and returns it typed", () => {
    const ds = loadDataset<Food>(validEnvelope());
    expect(ds.id).toBe("foods");
    expect(ds.entries).toHaveLength(2);
  });

  it("rejects a non-object", () => {
    expect(() => loadDataset(null)).toThrow(DatasetError);
    expect(() => loadDataset([])).toThrow(DatasetError);
  });

  it("rejects a missing id", () => {
    const e = { ...validEnvelope(), id: "" };
    expect(() => loadDataset(e)).toThrow(/non-empty `id`/);
  });

  it("rejects a wrong/absent schema marker", () => {
    const e = { ...validEnvelope(), $schema: "nope" };
    expect(() => loadDataset(e)).toThrow(/\$schema/);
  });

  it("rejects a missing title", () => {
    const e = { ...validEnvelope(), title: "" };
    expect(() => loadDataset(e)).toThrow(/title/);
  });

  it("rejects zero citations", () => {
    const e = { ...validEnvelope(), citation: [] };
    expect(() => loadDataset(e)).toThrow(/at least one citation/);
  });

  it("rejects a citation with an empty source", () => {
    const e = { ...validEnvelope(), citation: [{ source: "  " }] };
    expect(() => loadDataset(e)).toThrow(/non-empty `source`/);
  });

  it("rejects missing identity keys", () => {
    const e = { ...validEnvelope(), identity: { keys: [] } };
    expect(() => loadDataset(e)).toThrow(/identity\.keys/);
  });

  it("rejects a non-array entries", () => {
    const e = { ...validEnvelope(), entries: {} };
    expect(() => loadDataset(e)).toThrow(/`entries` array/);
  });

  it("rejects an entry missing a declared identity key", () => {
    const e = validEnvelope();
    // Drop `name` from one entry — identity requires both slug AND name.
    (e.entries[0] as Partial<Food>).name = undefined;
    expect(() => loadDataset(e)).toThrow(/missing identity key `name`/);
  });
});

describe("matcher strategies + refusal gate", () => {
  const ds = loadDataset<Food>(validEnvelope());

  it("nameStrategy matches case-insensitively and refuses the absent", () => {
    const m = createMatcher(ds, nameStrategy);
    expect(m.match("fatty fish")?.slug).toBe("fatty_fish");
    expect(m.has("OATS")).toBe(true);
    expect(m.match("tofu")).toBeNull();
    expect(m.match("")).toBeNull();
    expect(m.match(123)).toBeNull();
  });

  it("slugStrategy folds a display string to a slug", () => {
    const m = createMatcher(ds, slugStrategy);
    expect(m.match("Fatty Fish")?.slug).toBe("fatty_fish");
    expect(m.match("fatty_fish")?.name).toBe("Fatty Fish");
    expect(m.match("shellfish")).toBeNull();
    expect(m.keys().sort()).toEqual(["fatty_fish", "oats"]);
  });

  it("fieldStrategy resolves an arbitrary identity field", () => {
    const m = createMatcher(ds, fieldStrategy("name"));
    expect(m.match("Oats")?.kcal).toBe(150);
  });

  it("throws when the strategy key is not a declared identity key", () => {
    expect(() => createMatcher(ds, fieldStrategy("kcal"))).toThrow(
      /not one of dataset/
    );
  });

  it("first entry wins on a normalized-key collision (deterministic)", () => {
    const dup = validEnvelope();
    dup.entries = [
      { slug: "a", name: "Dup", kcal: 1 },
      { slug: "b", name: "dup", kcal: 2 },
    ];
    const m = createMatcher(loadDataset<Food>(dup), fieldStrategy("name"));
    expect(m.match("DUP")?.kcal).toBe(1);
  });

  it("rxcuiStrategyStub normalizes to digits (the future seam)", () => {
    expect(rxcuiStrategyStub().normalize("RxCUI:1234")).toBe("1234");
    expect(rxcuiStrategyStub().normalize(5678)).toBe("5678");
    expect(rxcuiStrategyStub().normalize(null)).toBe("");
  });
});

describe("harness assertions", () => {
  const ds = loadDataset<Food>(validEnvelope());

  it("citationPresent passes a cited dataset", () => {
    expect(citationPresent(ds).ok).toBe(true);
  });

  it("identityResolves passes when every entry self-resolves", () => {
    expect(identityResolves(ds, slugStrategy).ok).toBe(true);
    expect(identityResolves(ds, nameStrategy).ok).toBe(true);
  });

  it("refusalGate passes for a sentinel absent query", () => {
    expect(refusalGate(ds, nameStrategy).ok).toBe(true);
    expect(refusalGate(ds, nameStrategy, ["definitely absent"]).ok).toBe(true);
  });

  it("runHarness aggregates all three with no problems", () => {
    const r = runHarness(ds, slugStrategy);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("identityResolves reports an unindexable entry (empty normalized key)", () => {
    // An entry whose name is whitespace-only normalizes to "" under nameStrategy, so
    // it can't be indexed or resolved — the harness must flag it. (loadDataset allows
    // a non-empty string identity; nameStrategy is what can't index it.)
    const e = validEnvelope();
    e.entries = [{ slug: "x", name: "   ", kcal: 1 }];
    const ds2 = loadDataset<Food>(e);
    const r = identityResolves(ds2, nameStrategy);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/does not resolve/);
  });
});
