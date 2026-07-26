import { describe, it, expect } from "vitest";
import {
  RANK_SIGNAL_BUDGET,
  RankTableError,
  defineRankTable,
  itemsFromLayout,
  mergeStoredOrder,
  rankItems,
  rankedIds,
} from "@/lib/rank-core";

// A throwaway tenant: three items, a context of two booleans.
type Id = "a" | "b" | "c";
interface Ctx {
  boostB: boolean;
  emptyC: boolean;
}

const LAYOUT: readonly Id[] = ["a", "b", "c"];
const ITEMS = itemsFromLayout(LAYOUT);

const TABLE = defineRankTable<Id, Ctx>({
  tenant: "test",
  floors: [
    { key: "has-data", holds: (item, ctx) => !(ctx.emptyC && item.id === "c") },
  ],
  signals: [
    {
      key: "b-boost",
      boost: (item, ctx) => (ctx.boostB && item.id === "b" ? 100 : 0),
    },
  ],
});

const NO_SIGNALS: Ctx = { boostB: false, emptyC: false };

describe("itemsFromLayout", () => {
  it("weights the layout so index 0 ranks first", () => {
    expect(ITEMS).toEqual([
      { id: "a", base: 3 },
      { id: "b", base: 2 },
      { id: "c", base: 1 },
    ]);
  });
});

describe("rankItems", () => {
  it("returns the layout unchanged when no signal fires (the identity property)", () => {
    expect(rankedIds(ITEMS, TABLE, NO_SIGNALS)).toEqual(["a", "b", "c"]);
  });

  it("promotes an item whose signal fires", () => {
    expect(rankedIds(ITEMS, TABLE, { ...NO_SIGNALS, boostB: true })).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("keeps a floor member above every non-member whatever the scores say", () => {
    // c is boosted enormously but fails the floor — it still sinks.
    const table = defineRankTable<Id, Ctx>({
      tenant: "test",
      floors: [
        {
          key: "has-data",
          holds: (item, ctx) => !(ctx.emptyC && item.id === "c"),
        },
      ],
      signals: [
        { key: "c-boost", boost: (item) => (item.id === "c" ? 9999 : 0) },
      ],
    });
    expect(rankedIds(ITEMS, table, { boostB: false, emptyC: true })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks ties by base weight, then by declaration order", () => {
    const flat = [
      { id: "a" as Id, base: 1 },
      { id: "b" as Id, base: 1 },
      { id: "c" as Id, base: 2 },
    ];
    expect(rankedIds(flat, TABLE, NO_SIGNALS)).toEqual(["c", "a", "b"]);
  });

  it("is stable across repeated calls with the same context", () => {
    const ctx = { boostB: true, emptyC: true };
    const once = rankedIds(ITEMS, TABLE, ctx);
    expect(rankedIds(ITEMS, TABLE, ctx)).toEqual(once);
    expect(rankedIds(ITEMS, TABLE, ctx)).toEqual(once);
  });

  it("reports the firing boosts and held floors for explainability", () => {
    const [first] = rankItems(ITEMS, TABLE, { boostB: true, emptyC: false });
    expect(first.id).toBe("b");
    expect(first.boosts).toEqual([{ key: "b-boost", amount: 100 }]);
    expect(first.floors).toEqual(["has-data"]);
    expect(first.score).toBe(102);
  });
});

describe("defineRankTable", () => {
  it("refuses a table over the signal budget", () => {
    const signals = Array.from({ length: RANK_SIGNAL_BUDGET + 1 }, (_, i) => ({
      key: `s${i}`,
      boost: () => 0,
    }));
    expect(() => defineRankTable<Id, Ctx>({ tenant: "over", signals })).toThrow(
      RankTableError
    );
  });

  it("refuses a per-tenant budget above the global cap", () => {
    expect(() =>
      defineRankTable<Id, Ctx>({
        tenant: "greedy",
        signals: [],
        budget: RANK_SIGNAL_BUDGET + 1,
      })
    ).toThrow(RankTableError);
  });

  it("refuses duplicate signal keys", () => {
    expect(() =>
      defineRankTable<Id, Ctx>({
        tenant: "dupe",
        signals: [
          { key: "x", boost: () => 0 },
          { key: "x", boost: () => 1 },
        ],
      })
    ).toThrow(RankTableError);
  });

  it("accepts a table exactly at the budget", () => {
    const signals = Array.from({ length: RANK_SIGNAL_BUDGET }, (_, i) => ({
      key: `s${i}`,
      boost: () => 0,
    }));
    expect(() =>
      defineRankTable<Id, Ctx>({ tenant: "at-cap", signals })
    ).not.toThrow();
  });
});

describe("mergeStoredOrder", () => {
  it("returns the ranked order when nothing is stored", () => {
    expect(mergeStoredOrder(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
    expect(mergeStoredOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("lets a stored arrangement win over the ranked default", () => {
    expect(mergeStoredOrder(["a", "b", "c"], ["c", "b", "a"])).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("appends an unseen card at the end rather than reshuffling the arrangement", () => {
    // "b" is new (never arranged): the user's c → a order is untouched.
    expect(mergeStoredOrder(["a", "b", "c"], ["c", "a"])).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("drops stored ids the registry no longer has, and de-duplicates", () => {
    expect(mergeStoredOrder(["a", "b"], ["gone", "b", "b", "a"])).toEqual([
      "b",
      "a",
    ]);
  });
});
