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
  expand,
  multiValueStrategy,
  compositeKey,
  sortedPairKey,
  pairKeysAcross,
  pairStrategy,
  compositeStrategy,
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
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

// --- Multi-value + composite machinery (issue #860 wave 2) ----------------------

// A drug-ish entry carrying several identity aliases (generic + brands + a CUI set).
interface Drug {
  aliases: string[];
  cuis: number[];
  label: string;
}

function drugEnvelope(): DatasetEnvelope<Drug> {
  return {
    $schema: DATASET_SCHEMA,
    id: "drugs",
    title: "Test drugs",
    citation: [{ source: "A cited compendium" }],
    identity: { keys: ["aliases", "cuis"] },
    entries: [
      {
        aliases: ["Acetaminophen", "Tylenol", "Paracetamol"],
        cuis: [161, 1234],
        label: "acetaminophen",
      },
      {
        aliases: ["Ibuprofen", "Advil", "Motrin"],
        cuis: [5640],
        label: "ibuprofen",
      },
    ],
  };
}

describe("expand()", () => {
  it("falls back to a single normalized key for a single-value strategy", () => {
    expect(expand(nameStrategy, "Fatty Fish")).toEqual(["fatty fish"]);
    expect(expand(nameStrategy, "  ")).toEqual([]);
    expect(expand(nameStrategy, 123)).toEqual([]);
  });

  it("yields every key for a multi-value strategy, empties filtered", () => {
    const s = multiValueStrategy("aliases");
    expect(expand(s, ["Tylenol", "", "Paracetamol"])).toEqual([
      "tylenol",
      "paracetamol",
    ]);
  });
});

describe("multiValueStrategy", () => {
  const ds = loadDataset<Drug>(drugEnvelope());

  it("indexes one entry under every alias and resolves any of them", () => {
    const m = createMatcher(ds, multiValueStrategy("aliases"));
    expect(m.match("Tylenol")?.label).toBe("acetaminophen");
    expect(m.match("paracetamol")?.label).toBe("acetaminophen");
    expect(m.match("ACETAMINOPHEN")?.label).toBe("acetaminophen");
    expect(m.match("Advil")?.label).toBe("ibuprofen");
    expect(m.has("Motrin")).toBe(true);
  });

  it("refuses an alias no entry carries (the refusal gate holds)", () => {
    const m = createMatcher(ds, multiValueStrategy("aliases"));
    expect(m.match("Aspirin")).toBeNull();
    expect(m.match("")).toBeNull();
  });

  it("supports a custom per-element normalizer (an RxCUI digit fold)", () => {
    const digits = rxcuiStrategyStub().normalize;
    const m = createMatcher(ds, multiValueStrategy("cuis", digits));
    expect(m.match(161)?.label).toBe("acetaminophen");
    expect(m.match("RxCUI:1234")?.label).toBe("acetaminophen");
    expect(m.match(5640)?.label).toBe("ibuprofen");
    expect(m.match(9999)).toBeNull();
  });

  it("resolves the whole alias array to the entry (identityResolves shape)", () => {
    const m = createMatcher(ds, multiValueStrategy("aliases"));
    expect(m.match(["Acetaminophen", "Tylenol", "Paracetamol"])?.label).toBe(
      "acetaminophen"
    );
  });
});

describe("composite + pair key builders", () => {
  it("compositeKey folds parts and joins in the given (ordered) slot order", () => {
    expect(compositeKey(["CYP2C19", "*2"])).toBe("cyp2c19|*2");
    expect(compositeKey(["CYP2D6", "Codeine"])).toBe("cyp2d6|codeine");
    // A missing part refuses (empty key).
    expect(compositeKey(["CYP2C19", ""])).toBe("");
    expect(compositeKey(["CYP2C19", "  "])).toBe("");
  });

  it("sortedPairKey is order-independent (drug-drug symmetry)", () => {
    expect(sortedPairKey("Warfarin", "Aspirin")).toBe("aspirin|warfarin");
    expect(sortedPairKey("Aspirin", "Warfarin")).toBe("aspirin|warfarin");
    expect(sortedPairKey("Aspirin", "")).toBe("");
  });

  it("pairKeysAcross builds the sorted cross product of two concept sets", () => {
    const keys = pairKeysAcross(["warfarin", "coumadin"], ["aspirin", "asa"]);
    expect(keys.sort()).toEqual([
      "asa|coumadin",
      "asa|warfarin",
      "aspirin|coumadin",
      "aspirin|warfarin",
    ]);
    // A query pair from EITHER side resolves to a member key.
    expect(keys).toContain(sortedPairKey("aspirin", "warfarin"));
    expect(keys).toContain(sortedPairKey("coumadin", "asa"));
  });
});

describe("pairStrategy (unordered pair identity)", () => {
  interface Interaction {
    pair: [string, string];
    severity: string;
  }
  const ds = loadDataset<Interaction>({
    $schema: DATASET_SCHEMA,
    id: "interactions",
    title: "Test interactions",
    citation: [{ source: "A cited interaction table" }],
    identity: { keys: ["pair"] },
    entries: [
      { pair: ["Warfarin", "Aspirin"], severity: "major" },
      { pair: ["Sildenafil", "Nitroglycerin"], severity: "contraindicated" },
    ],
  });

  it("resolves a pair queried in EITHER order to the same rule", () => {
    const m = createMatcher(ds, pairStrategy("pair"));
    expect(m.match(["Warfarin", "Aspirin"])?.severity).toBe("major");
    expect(m.match(["Aspirin", "Warfarin"])?.severity).toBe("major");
    expect(m.match(["nitroglycerin", "sildenafil"])?.severity).toBe(
      "contraindicated"
    );
  });

  it("refuses an unlisted pair and a malformed query", () => {
    const m = createMatcher(ds, pairStrategy("pair"));
    expect(m.match(["Warfarin", "Ibuprofen"])).toBeNull();
    expect(m.match(["Warfarin"])).toBeNull();
    expect(m.match("Warfarin")).toBeNull();
  });
});

describe("compositeStrategy (ordered gene|allele / gene|drug)", () => {
  interface PgxRule {
    combo: [string, string];
    note: string;
  }
  const ds = loadDataset<PgxRule>({
    $schema: DATASET_SCHEMA,
    id: "pgx",
    title: "Test PGx",
    citation: [{ source: "A cited PGx guideline" }],
    identity: { keys: ["combo"] },
    entries: [
      { combo: ["CYP2C19", "*2"], note: "poor metabolizer allele" },
      { combo: ["CYP2D6", "Codeine"], note: "avoid" },
    ],
  });

  it("resolves an ordered composite and preserves slot order", () => {
    const m = createMatcher(ds, compositeStrategy("combo"));
    expect(m.match(["CYP2C19", "*2"])?.note).toBe("poor metabolizer allele");
    expect(m.match(["cyp2d6", "codeine"])?.note).toBe("avoid");
    // Order matters (unlike a pair) — the swapped composite is a different key.
    expect(m.match(["*2", "CYP2C19"])).toBeNull();
    expect(m.match(["CYP2C19", "*17"])).toBeNull();
  });
});

describe("noKeyCollisions harness", () => {
  it("passes a multi-value dataset with disjoint aliases", () => {
    const ds = loadDataset<Drug>(drugEnvelope());
    expect(noKeyCollisions(ds, multiValueStrategy("aliases")).ok).toBe(true);
    expect(runHarness(ds, multiValueStrategy("aliases")).ok).toBe(true);
  });

  it("flags a shared alias two entries both index (silent shadowing)", () => {
    const e = drugEnvelope();
    // Give ibuprofen a stray "Tylenol" alias on a NON-first key — it still resolves to
    // itself, but it shadows acetaminophen on that key. identityResolves alone misses
    // this; noKeyCollisions catches it.
    e.entries[1].aliases = ["Ibuprofen", "Tylenol"];
    const ds = loadDataset<Drug>(e);
    const r = noKeyCollisions(ds, multiValueStrategy("aliases"));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/both index key "tylenol"/);
    // And runHarness surfaces it too.
    expect(runHarness(ds, multiValueStrategy("aliases")).ok).toBe(false);
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
