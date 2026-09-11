import { describe, expect, it } from "vitest";
import {
  groupHistoryBundles,
  isHistoryBundle,
  type HistoryBundleFact,
  type HistoryEntry,
} from "@/lib/history-bundle";
import {
  detailSegment,
  historyClock,
  type HistoryKind,
  type HistoryRow,
} from "@/lib/history-format";
import type { DisplayFormatPrefs } from "@/lib/format-date";

// A COMPOSED ACT IS ONE ROW ON THE RECORD (#5618 ruling 5), asserted where the decision
// actually lives: the collapse is a pure function over one day's already-composed rows,
// so every claim here is a claim about the rule rather than about a fixture that
// happened to render. The rendered half — what the row says and what its ⋯ offers — is
// components/__tests__/history-bundle-row.test.tsx, over the same shapes.

const H12: DisplayFormatPrefs = { timeFormat: "12h", dateFormat: "mdy" };

function row(
  kind: HistoryKind,
  id: number,
  over: Partial<HistoryRow> = {}
): HistoryRow {
  return {
    id: `${kind}:${id}`,
    kind,
    tz: "UTC",
    profileId: 1,
    date: "2026-09-08",
    sortTime: "07:41",
    clock: historyClock("07:41", "stated", H12),
    clockKind: "stated",
    title: kind,
    href: null,
    detail: detailSegment([]),
    media: 0,
    edit: null,
    ...over,
  };
}

/** A serving as the usual tap files it: the window declared, no eating instant. */
function serving(id: number, over: Partial<HistoryRow> = {}): HistoryRow {
  return row("food", id, {
    title: "Fermented foods",
    clock: historyClock("07:41", "logged", H12),
    clockKind: "logged",
    ...over,
  });
}

function dose(id: number, name: string, over: Partial<HistoryRow> = {}) {
  return row("dose", id, { title: name, ...over });
}

function facts(
  entries: [string, Partial<HistoryBundleFact> & { bundleId: string }][]
): Map<string, HistoryBundleFact> {
  return new Map(
    entries.map(([rowId, fact]) => [
      rowId,
      { window: null, stack: null, bucket: null, ...fact },
    ])
  );
}

const bundles = (entries: HistoryEntry[]) => entries.filter(isHistoryBundle);
const titles = (entries: HistoryEntry[]) => entries.map((e) => e.title);

describe("one composed act, collapsed", () => {
  // THE ACCEPTANCE CASE, in the issue's own words: a usual tap on a past day renders ONE
  // row named "Your usual Morning" with its members beneath, and the act's clock is the
  // one every member agrees on.
  it("renders a usual tap as one row named for the offer that wrote it", () => {
    const rows = [
      serving(11),
      serving(12, { title: "Berries" }),
      dose(21, "Creatine", {
        clock: historyClock("07:41", "logged", H12),
        clockKind: "logged",
      }),
      dose(22, "B complex", {
        clock: historyClock("07:41", "logged", H12),
        clockKind: "logged",
      }),
    ];
    const entries = groupHistoryBundles(
      rows,
      facts([
        ["food:11", { bundleId: "a1", window: "Morning" }],
        ["food:12", { bundleId: "a1", window: "Morning" }],
        ["dose:21", { bundleId: "a1", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "a1", stack: "Morning Smoothie" }],
      ])
    );
    expect(entries).toHaveLength(1);
    const [act] = bundles(entries);
    expect(act!.title).toBe("Your usual Morning");
    // The census is the ledger's own count, and it is what makes #5074 B's
    // "Your usual Morning · 6 doses" the row's two cells rather than a sentence.
    expect(act!.detail).toBe("2 servings · 2 doses");
    expect(act!.members.map((m) => m.title)).toEqual([
      "Fermented foods",
      "Berries",
      "Creatine",
      "B complex",
    ]);
    // The two id spaces the batch correction cores take, and nothing else.
    expect(act!.servingIds).toEqual([11, 12]);
    expect(act!.doseLogIds).toEqual([21, 22]);
    expect(act!.clock).toBe(historyClock("07:41", "logged", H12));
  });

  // #5074 B's second spelling: an act that IS one declared stack is that stack's row.
  it("names a dose-only act after the stack every member declares", () => {
    const entries = groupHistoryBundles(
      [dose(21, "Creatine"), dose(22, "Collagen"), dose(23, "B complex")],
      facts([
        ["dose:21", { bundleId: "b2", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "b2", stack: "Morning Smoothie" }],
        ["dose:23", { bundleId: "b2", stack: "Morning Smoothie" }],
      ])
    );
    expect(titles(entries)).toEqual(["Morning Smoothie"]);
    expect(bundles(entries)[0]!.detail).toBe("3 doses");
  });

  // #5074 B's third: a bucket take is the bucket, which with the census cell reads
  // "Morning · 6 doses" exactly as the ruling spells it.
  it("names a bucket take after its bucket when no stack is shared", () => {
    const entries = groupHistoryBundles(
      [dose(31, "Creatine"), dose(32, "Vitamin D")],
      facts([
        [
          "dose:31",
          { bundleId: "c3", stack: "Morning Smoothie", bucket: "Morning" },
        ],
        ["dose:32", { bundleId: "c3", stack: null, bucket: "Morning" }],
      ])
    );
    expect(titles(entries)).toEqual(["Morning"]);
    expect(bundles(entries)[0]!.detail).toBe("2 doses");
  });

  it("falls back to naming the members when they share neither stack nor bucket", () => {
    const entries = groupHistoryBundles(
      [dose(41, "Creatine"), dose(42, "Magnesium")],
      facts([
        ["dose:41", { bundleId: "d4", bucket: "Morning" }],
        ["dose:42", { bundleId: "d4", bucket: "Evening" }],
      ])
    );
    expect(titles(entries)).toEqual(["Creatine and Magnesium"]);
  });

  it("takes the position of its first member and leaves the rest of the order alone", () => {
    const entries = groupHistoryBundles(
      [
        row("substance", 1, { title: "Coffee" }),
        dose(51, "Creatine"),
        row("symptom", 2, { title: "Headache" }),
        dose(52, "Collagen"),
      ],
      facts([
        ["dose:51", { bundleId: "e5", stack: "Morning Smoothie" }],
        ["dose:52", { bundleId: "e5", stack: "Morning Smoothie" }],
      ])
    );
    expect(titles(entries)).toEqual(["Coffee", "Morning Smoothie", "Headache"]);
  });
});

describe("what refuses to collapse", () => {
  // THE BOUNDARY MOST LIKELY TO BREAK SILENTLY. Every row written before 2026-09-04
  // carries no `bundle_id` at all (the column has no backfill, by ruling), and a
  // grouping keyed on that absence would fold a morning and an evening into one row
  // that states one time for both. There are no facts for such rows AT ALL, which is
  // what makes this true by construction rather than by a branch — so the assertion is
  // that an empty fact map leaves the day exactly as it found it.
  it("leaves every pre-2026-09-04 row flat, one row per row", () => {
    const rows = [
      serving(11, { title: "Fermented foods" }),
      dose(21, "Creatine"),
      dose(22, "Collagen"),
      dose(23, "B complex", {
        clock: historyClock("21:15", "stated", H12),
        sortTime: "21:15",
      }),
    ];
    const entries = groupHistoryBundles(rows, new Map());
    expect(entries).toEqual(rows);
    expect(bundles(entries)).toEqual([]);
    expect(entries).toHaveLength(4);
  });

  // The same day with SOME rows carrying an id: the old rows must not be swept into the
  // new act, and the mixed case is the one a real profile actually has.
  it("collapses only the rows that recorded an act, on a day holding both", () => {
    const entries = groupHistoryBundles(
      [
        dose(21, "Creatine"),
        dose(22, "Collagen"),
        dose(23, "Old vitamin"),
        dose(24, "Older vitamin"),
      ],
      facts([
        ["dose:21", { bundleId: "f6", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "f6", stack: "Morning Smoothie" }],
      ])
    );
    expect(titles(entries)).toEqual([
      "Morning Smoothie",
      "Old vitamin",
      "Older vitamin",
    ]);
    expect(bundles(entries)).toHaveLength(1);
  });

  // `buildDayLedger`'s dissolution loop, in the record's vocabulary: a single row is not
  // a composed write however it was stored, so it reads as itself.
  it("dissolves an act that holds one row on this day", () => {
    const entries = groupHistoryBundles(
      [dose(21, "Creatine"), dose(22, "Collagen")],
      facts([
        ["dose:21", { bundleId: "g7", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "h8", stack: "Morning Smoothie" }],
      ])
    );
    expect(titles(entries)).toEqual(["Creatine", "Collagen"]);
    expect(bundles(entries)).toEqual([]);
  });

  // The ledger's clock rule (#3987/#4477): a member amended to its own time steps out of
  // the collapse, because a collapsed row carries ONE clock and may not state a time its
  // members disagree about.
  it("refuses the collapse when two members now state different times", () => {
    const entries = groupHistoryBundles(
      [
        dose(21, "Creatine"),
        dose(22, "Collagen", {
          sortTime: "10:07",
          clock: historyClock("10:07", "stated", H12),
        }),
      ],
      facts([
        ["dose:21", { bundleId: "i9", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "i9", stack: "Morning Smoothie" }],
      ])
    );
    expect(bundles(entries)).toEqual([]);
    expect(titles(entries)).toEqual(["Creatine", "Collagen"]);
  });

  // …AND AN UNSTATED MEMBER IS NOT A DISAGREEMENT, which is the one place this differs
  // from the ledger's key. A usual tap on TODAY stamps its doses with the tap instant
  // and files its servings as a window declaration with no eating instant at all
  // (#4438), so the halves' clock KINDS differ at write time by construction. A serving
  // that states nothing has made no claim to contradict; it joins the act, and the row
  // states the time its stating members agree on.
  it("keeps an unstated serving inside an act its doses have stated", () => {
    const entries = groupHistoryBundles(
      [serving(11), dose(21, "Creatine"), dose(22, "Collagen")],
      facts([
        ["food:11", { bundleId: "j1", window: "Morning" }],
        ["dose:21", { bundleId: "j1", stack: "Morning Smoothie" }],
        ["dose:22", { bundleId: "j1", stack: "Morning Smoothie" }],
      ])
    );
    const [act] = bundles(entries);
    expect(act!.members).toHaveLength(3);
    expect(act!.clockKind).toBe("stated");
    expect(act!.clock).toBe(historyClock("07:41", "stated", H12));
  });
});
