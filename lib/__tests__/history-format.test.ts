import { describe, expect, it } from "vitest";
import {
  HISTORY_DEFAULT_SHOW,
  HISTORY_MAX_SHOW,
  clampHistoryDay,
  detailSegment,
  historyClock,
  parseHistoryShow,
  resolveHistoryDoseClass,
  resolveHistoryFamily,
  resolveHistoryKind,
  type HistoryRow,
} from "@/lib/history-format";
import { historyHref } from "@/lib/hrefs";
import { mergeMemberTimelines, type MergeableRow } from "@/lib/timeline-multi";
import type { DisplayFormatPrefs } from "@/lib/format-date";

const H12: DisplayFormatPrefs = { timeFormat: "12h", dateFormat: "mdy" };
const H24: DisplayFormatPrefs = { timeFormat: "24h", dateFormat: "mdy" };

describe("detailSegment", () => {
  // The whole contract in one table: join with "·", drop what is empty, and never
  // shorten. The truncation case is the one that matters — a string-level cap
  // cannot know the viewport, which is why overflow is the row's CSS ellipsis.
  it.each([
    [["3 g", "Brand X"], "3 g · Brand X"],
    [["3 g", null, undefined, "Brand X"], "3 g · Brand X"],
    [["  3 g  ", "  ", "Strava"], "3 g · Strava"],
    [[null, undefined, "", false], ""],
    [["20 min"], "20 min"],
  ])("joins %j into %j", (parts, expected) => {
    expect(detailSegment(parts as (string | null)[])).toBe(expected);
  });

  it("never truncates, however many parts or however long", () => {
    const parts = Array.from({ length: 9 }, (_, i) => `part ${i}`);
    const out = detailSegment(parts);
    expect(out.split(" · ")).toHaveLength(9);
    expect(out).not.toContain("…");
    expect(out).not.toContain("more");
  });
});

describe("historyClock", () => {
  // ONE MERIDIEM STYLE, PAGE-WIDE. The drift this retires is real and shipped: the
  // food ledger printed "Ate 2:03 PM" while the dose ledger printed "recorded
  // 12:02pm" in the same app, so the record has to be able to fail on a second
  // spelling rather than merely prefer the first.
  it.each([
    ["10:07", "stated", H12, "10:07am"],
    ["14:03", "stated", H12, "2:03pm"],
    ["10:07", "logged", H12, "logged 10:07am"],
    ["14:03", "logged", H24, "logged 14:03"],
    ["14:03", "stated", H24, "14:03"],
  ] as const)("renders %s/%s as %s", (hhmm, kind, prefs, expected) => {
    expect(historyClock(hhmm, kind, prefs)).toBe(expected);
  });

  it("has no clock at all for a row with no instant", () => {
    expect(historyClock(null, "stated", H12)).toBeNull();
  });

  it("prints no upper-case meridiem and no second qualifier", () => {
    for (const kind of ["stated", "logged"] as const) {
      const out = historyClock("14:03", kind, H12) ?? "";
      expect(out).not.toMatch(/AM|PM/);
      expect(out).not.toMatch(/\b(Ate|recorded|Logged)\b/);
    }
  });
});

describe("the URL grammar", () => {
  it.each([
    [{}, "/history"],
    [{ kind: "dose" as const }, "/history?kind=dose"],
    // A kind IMPLIES its family, so a URL can never contradict itself.
    [{ family: "logs" as const, kind: "food" as const }, "/history?kind=food"],
    [{ family: "logs" as const }, "/history?family=logs"],
    [
      { kind: "dose" as const, class: "medication" as const },
      "/history?kind=dose&class=medication",
    ],
    [
      { kind: "food" as const, day: "2026-08-18" },
      "/history?kind=food&day=2026-08-18",
    ],
    [{ media: true }, "/history?media=1"],
    [{ everyone: true }, "/history?view=everyone"],
    [{ open: ["2026-03", "2025"] }, "/history?open=2026-03&open=2025"],
    [{ show: 400 }, "/history?show=400"],
  ])("builds %j as %s", (params, expected) => {
    expect(historyHref(params)).toBe(expected);
  });

  it("puts params in a fixed order whatever the caller's object literal", () => {
    expect(historyHref({ show: 400, kind: "body", media: true })).toBe(
      historyHref({ media: true, kind: "body", show: 400 })
    );
  });

  // A BAD DEEP LINK DEGRADES TO THE PAGE, never to a 404 — including a phase-2
  // family that has not shipped and a `?day` in the future.
  it.each([
    ["dose", "dose"],
    ["DOSE", "dose"],
    ["sleep", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("resolves ?kind=%s to %s", (raw, expected) => {
    expect(resolveHistoryKind(raw)).toBe(expected);
  });

  it.each([
    ["logs", "logs"],
    ["clinical", "clinical"],
    ["nonsense", undefined],
  ])("resolves ?family=%s to %s", (raw, expected) => {
    expect(resolveHistoryFamily(raw)).toBe(expected);
  });

  it.each([
    ["supplement", "supplement"],
    ["medication", "medication"],
    ["all", undefined],
  ])("resolves ?class=%s to %s", (raw, expected) => {
    expect(resolveHistoryDoseClass(raw)).toBe(expected);
  });

  it.each([
    ["2026-08-18", "2026-08-18"],
    // The record ends at now: a future day clamps rather than rendering a
    // speculative empty day the gather would have nothing for.
    ["2027-01-01", "2026-08-28"],
    ["not-a-day", undefined],
    [undefined, undefined],
  ])("clamps ?day=%s to %s", (raw, expected) => {
    expect(clampHistoryDay(raw, "2026-08-28")).toBe(expected);
  });

  it.each([
    [undefined, HISTORY_DEFAULT_SHOW],
    ["10", HISTORY_DEFAULT_SHOW],
    ["9999", HISTORY_MAX_SHOW],
    ["400", 400],
  ])("parses ?show=%s as %s", (raw, expected) => {
    expect(parseHistoryShow(raw)).toBe(expected);
  });
});

// ── THE ORDERING CONTRACT ────────────────────────────────────────────────────
//
// "Instant descending within a day; date-only rows sink below timed ones;
// same-instant rows tie-break on id." The record composes `mergeMemberTimelines`
// rather than owning a comparator, so this asserts the contract THROUGH the
// production path — a test against a private comparator would go green over a page
// that had quietly stopped calling it.

const DAY = "2026-08-18";

function row(id: string, sortTime: string | null): HistoryRow {
  return {
    id,
    kind: "dose",
    profileId: 1,
    date: DAY,
    sortTime,
    clock: sortTime,
    clockKind: "stated",
    title: id,
    href: null,
    detail: "",
    media: 0,
    edit: null,
  };
}

function order(rows: HistoryRow[]): string[] {
  const days = mergeMemberTimelines([
    { profileId: 1, today: "2026-08-28", events: rows },
  ]);
  return days.flatMap((day) => day.events.map((event) => event.id));
}

/** Every permutation of `items` — the input orders a reader can actually get. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

describe("within-day order", () => {
  it("is instant descending, with date-only rows sunk below timed ones", () => {
    expect(
      order([
        row("dose:1", "08:00"),
        row("substance:alcohol:1", null),
        row("dose:2", "21:30"),
        row("body:weight_kg:1", "07:00"),
      ])
    ).toEqual(["dose:2", "dose:1", "body:weight_kg:1", "substance:alcohol:1"]);
  });

  // THE CASE THE TIE-BREAK EXISTS FOR: one usual-routine tap writes six rows in one
  // minute, so six rows share an instant and nothing but the id separates them.
  const stack = [
    row("dose:11", "08:46"),
    row("dose:12", "08:46"),
    row("dose:13", "08:46"),
    row("dose:14", "08:46"),
    row("dose:15", "08:46"),
    row("dose:16", "08:46"),
  ];

  it("is BYTE-STABLE across every input order, not merely stable in one fixture", () => {
    const orders = permutations(stack).map(order);
    expect(orders).toHaveLength(720);
    const first = JSON.stringify(orders[0]);
    // Serialized and compared as ONE value: asserting per-permutation would report
    // the first divergence and hide how many orders the page can actually produce.
    expect(new Set(orders.map((o) => JSON.stringify(o)))).toEqual(
      new Set([first])
    );
  });

  // PROVE THE GUARD CAN SEE. "Stable in this fixture" and "byte-stable" produce the
  // same green over a sorted input, which is exactly the defect class this repo keeps
  // meeting — a guard that survives the change it was written to catch. So the same
  // permutations go through a comparator with the id tie-break REMOVED, and the guard
  // above must be able to fail on it. It does: V8's sort is stable, so a comparator
  // that returns 0 for the whole stack hands back whatever order it was given.
  it("would fail without the id tie-break", () => {
    const withoutTieBreak = (rows: HistoryRow[]): string[] =>
      [...rows]
        .sort((a: MergeableRow, b: MergeableRow) => {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          const at = a.sortTime ?? "";
          const bt = b.sortTime ?? "";
          if (at !== bt) return at < bt ? 1 : -1;
          return 0;
        })
        .map((r) => r.id);
    const orders = new Set(
      permutations(stack).map((perm) => JSON.stringify(withoutTieBreak(perm)))
    );
    expect(
      orders.size,
      "the control comparator produced one order, so the byte-stability guard " +
        "above cannot tell a tie-break from V8's incidental sort stability"
    ).toBe(720);
  });

  it("separates two members' rows that share an id and an instant", () => {
    const mine = { ...row("dose:1", "08:46"), profileId: 1 };
    const theirs = { ...row("dose:1", "08:46"), profileId: 2 };
    const merged = mergeMemberTimelines([
      { profileId: 1, today: "2026-08-28", events: [mine] },
      { profileId: 2, today: "2026-08-28", events: [theirs] },
    ]);
    expect(merged[0].events.map((e) => e.profileId)).toEqual([1, 2]);
  });
});
