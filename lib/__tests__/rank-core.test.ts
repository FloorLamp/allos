import { describe, it, expect } from "vitest";
import {
  RANK_SIGNAL_BUDGET,
  RankTableError,
  defineRankTable,
  itemsFromLayout,
  groupRankedBySubject,
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

// ── NOW'S CHANGED SORT CONTRACT (#4752 item 6) ──────────────────────────────
//
// Group by subject, rank within group, and only when more than one subject is
// present. Asserted here rather than through a render, because the ordering IS the
// contract: a host that draws labels from it is downstream of this.
describe("groupRankedBySubject", () => {
  const row = (id: string, subject: string) => ({ id, subject });
  const shape = (
    groups: { subject: string; members: { id: string }[] }[] | null
  ) =>
    groups?.map((group) => [
      group.subject,
      group.members.map((member) => member.id).join(","),
    ]) ?? null;

  it.each([
    // [name, ordered rows, expected [subject, members] pairs or null]
    ["one subject is not a grouping", [row("a", "7"), row("b", "7")], null],
    ["an empty list has nothing to group", [], null],
    [
      "gathers a subject's rows without promoting it",
      [row("a", "7"), row("b", "2"), row("c", "7"), row("d", "11")],
      [
        ["7", "a,c"],
        ["2", "b"],
        ["11", "d"],
      ],
    ],
    [
      // A group's seat is its BEST member's: 2 leads because its first row
      // outranked every row of 7, and gathering 7's tail cannot change that.
      "seats a group where its first member ranked",
      [row("a", "2"), row("b", "7"), row("c", "2"), row("d", "7")],
      [
        ["2", "a,c"],
        ["7", "b,d"],
      ],
    ],
  ] as const)("%s", (_name, ordered, expected) => {
    expect(
      shape(groupRankedBySubject(ordered, (item) => item.subject))
    ).toEqual(expected);
  });

  it("keeps the incoming rank inside a group", () => {
    // The rank arrives as the array order and nothing here re-sorts it: reversing
    // the input reverses each group's members, so this could fail.
    const ordered = [
      row("a", "7"),
      row("b", "2"),
      row("c", "7"),
      row("d", "7"),
    ];
    expect(shape(groupRankedBySubject(ordered, (i) => i.subject))).toEqual([
      ["7", "a,c,d"],
      ["2", "b"],
    ]);
    expect(
      shape(groupRankedBySubject([...ordered].reverse(), (i) => i.subject))
    ).toEqual([
      ["7", "d,c,a"],
      ["2", "b"],
    ]);
  });
});
