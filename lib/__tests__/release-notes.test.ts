import { describe, expect, it } from "vitest";
import {
  ReleaseNotesError,
  hasUnseenNotes,
  issueUrl,
  loadReleaseNotes,
  newestNoteDate,
  parseReleaseNotes,
  pullRequestUrl,
  releaseNoteEntryKey,
  releaseNotesPage,
  RELEASE_NOTE_KINDS,
  WHATS_NEW_PAGE_ENTRIES,
  CATEGORIZED_SINCE,
  CONCISE_TITLE_LENGTH,
  groupDayEntries,
} from "@/lib/release-notes";
import shipped from "@/lib/release-notes.json";

// The bundled release notes (issue #1421) are hand-curated bookkeeping, so the two
// things worth pinning are: (1) the SHIPPED file actually validates — a typo in a
// release-time edit fails CI here rather than rendering a broken /whats-new — and
// (2) the ONE unread comparison shared by the page and the dot.

const day = (over: Record<string, unknown> = {}) => ({
  date: "2026-07-24",
  entries: [{ pr: 1, title: "T", issues: [] }],
  operatorNotes: [],
  ...over,
});

describe("parseReleaseNotes", () => {
  it("accepts a well-formed file and keeps the optional kind", () => {
    const notes = parseReleaseNotes({
      days: [
        day({
          entries: [
            { pr: 12, title: "A", kind: "fix", issues: [3, 4] },
            { pr: 13, title: "B", issues: [] },
          ],
          operatorNotes: ["run the thing"],
        }),
      ],
    });
    expect(notes.days).toHaveLength(1);
    expect(notes.days[0].entries[0].kind).toBe("fix");
    expect(notes.days[0].entries[0].issues).toEqual([3, 4]);
    // An entry with no kind stays undefined rather than defaulting to a chip.
    expect(notes.days[0].entries[1].kind).toBeUndefined();
    expect(notes.days[0].operatorNotes).toEqual(["run the thing"]);
  });

  it("keeps separate bullets from the same PR separately identifiable", () => {
    const notes = parseReleaseNotes({
      days: [
        day({
          entries: [
            { pr: 12, title: "First change", issues: [3] },
            { pr: 12, title: "Second change", issues: [4] },
          ],
        }),
      ],
    });

    expect(notes.days[0].entries.map((entry) => entry.title)).toEqual([
      "First change",
      "Second change",
    ]);
    expect(
      notes.days[0].entries.map((entry, index) =>
        releaseNoteEntryKey(entry, index)
      )
    ).toEqual(["12:0", "12:1"]);
  });

  it("sorts days newest-first regardless of file order", () => {
    const notes = parseReleaseNotes({
      days: [
        day({ date: "2026-01-02" }),
        day({ date: "2026-07-24" }),
        day({ date: "2026-03-15" }),
      ],
    });
    expect(notes.days.map((d) => d.date)).toEqual([
      "2026-07-24",
      "2026-03-15",
      "2026-01-02",
    ]);
  });

  it("defaults a missing operatorNotes array to empty", () => {
    const notes = parseReleaseNotes({
      days: [{ date: "2026-07-24", entries: day().entries }],
    });
    expect(notes.days[0].operatorNotes).toEqual([]);
  });

  it.each([
    ["not an object", 42],
    ["missing days", {}],
    ["days not an array", { days: {} }],
    ["day missing date", { days: [{ entries: day().entries }] }],
    ["non-ISO date", { days: [day({ date: "24/07/2026" })] }],
    ["empty entries", { days: [day({ entries: [] })] }],
    [
      "entry missing title",
      { days: [day({ entries: [{ pr: 1, issues: [] }] })] },
    ],
    [
      // Bodies are RETIRED (2026-08-13): a change is one concise bullet, and the
      // validator is what keeps prose from creeping back.
      "a body (retired)",
      {
        days: [
          day({ entries: [{ pr: 1, title: "t", body: "prose", issues: [] }] }),
        ],
      },
    ],
    [
      "an over-long title (a bullet, not a paragraph)",
      {
        days: [
          day({ entries: [{ pr: 1, title: "x".repeat(121), issues: [] }] }),
        ],
      },
    ],
    [
      "non-numeric pr",
      {
        days: [day({ entries: [{ pr: "1", title: "t", issues: [] }] })],
      },
    ],
    [
      "unknown kind",
      {
        days: [
          day({
            entries: [{ pr: 1, title: "t", kind: "chore", issues: [] }],
          }),
        ],
      },
    ],
    [
      "issues not an array",
      {
        days: [day({ entries: [{ pr: 1, title: "t", issues: 3 }] })],
      },
    ],
    ["operator note not a string", { days: [day({ operatorNotes: [7] })] }],
    ["duplicate dates", { days: [day(), day()] }],
  ])("rejects %s with a typed error", (_label, value) => {
    expect(() => parseReleaseNotes(value)).toThrow(ReleaseNotesError);
  });

  it("names the offending field on the error", () => {
    try {
      parseReleaseNotes({ days: [day({ date: "nope" })] });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReleaseNotesError);
      expect((e as ReleaseNotesError).path).toBe("days[0].date");
    }
  });
});

describe("the shipped release-notes.json", () => {
  it("validates against the schema", () => {
    expect(() => parseReleaseNotes(shipped)).not.toThrow();
  });

  it("loads (memoized) with at least one dated wave", () => {
    const notes = loadReleaseNotes();
    expect(notes.days.length).toBeGreaterThan(0);
    expect(loadReleaseNotes()).toBe(notes);
    expect(newestNoteDate(notes)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses only known kinds and links every entry to its PR", () => {
    for (const d of loadReleaseNotes().days) {
      for (const e of d.entries) {
        if (e.kind) expect(RELEASE_NOTE_KINDS).toContain(e.kind);
        expect(pullRequestUrl(e.pr)).toContain(`/pull/${e.pr}`);
      }
    }
  });
});

describe("newestNoteDate", () => {
  it("returns null for an empty set", () => {
    expect(newestNoteDate({ days: [] })).toBeNull();
  });

  it("returns the max date, not the first", () => {
    const notes = { days: [day({ date: "2026-01-01" }), day()] };
    // Built by hand (unsorted) on purpose — the max must not depend on order.
    expect(newestNoteDate(notes)).toBe("2026-07-24");
  });
});

describe("hasUnseenNotes", () => {
  it("is true when the login has never seen any notes", () => {
    expect(hasUnseenNotes("2026-07-24", null)).toBe(true);
    expect(hasUnseenNotes("2026-07-24", undefined)).toBe(true);
  });

  it("is true when the marker is older than the newest note", () => {
    expect(hasUnseenNotes("2026-07-24", "2026-07-01")).toBe(true);
  });

  it("is false once the marker matches the newest note", () => {
    expect(hasUnseenNotes("2026-07-24", "2026-07-24")).toBe(false);
  });

  it("is false for a marker from the future (rolled-back image)", () => {
    expect(hasUnseenNotes("2026-07-24", "2027-01-01")).toBe(false);
  });

  it("is false when the build bundles no notes at all", () => {
    expect(hasUnseenNotes(null, null)).toBe(false);
    expect(hasUnseenNotes(null, "2026-07-24")).toBe(false);
  });
});

describe("external links", () => {
  it("point at the repo the version hash links to", () => {
    expect(pullRequestUrl(1421)).toBe(
      "https://github.com/FloorLamp/allos/pull/1421"
    );
    expect(issueUrl(1421)).toBe(
      "https://github.com/FloorLamp/allos/issues/1421"
    );
  });
});

// ── The page's bound (#2528) ─────────────────────────────────────────────────
//
// The notes file is append-only by design, so /whats-new was a surface guaranteed to
// grow forever: 20 days / 278 entries rendered 76,647 px tall on a phone. The bound
// is counted in ENTRIES because a merge day here holds anywhere from 1 to 32 of them.
describe("releaseNotesPage", () => {
  const entries = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({
      pr: from + i,
      title: `T${from + i}`,
      issues: [],
    }));
  // Three days of 3/1/4 entries, newest first once parsed.
  const notes = parseReleaseNotes({
    days: [
      {
        date: "2026-08-03",
        entries: entries(3, 100),
        operatorNotes: ["run X"],
      },
      { date: "2026-08-02", entries: entries(1, 200), operatorNotes: [] },
      {
        date: "2026-08-01",
        entries: entries(4, 300),
        operatorNotes: ["run Y"],
      },
    ],
  });

  const prs = (days: { entries: { pr: number }[] }[]) =>
    days.flatMap((d) => d.entries.map((e) => e.pr));

  it("caps a page at its entry count, whatever the day shapes are", () => {
    const first = releaseNotesPage(notes, 1, 3);
    expect(first.shown).toBe(3);
    expect(first.total).toBe(8);
    expect(first.pageCount).toBe(3);
    expect(prs(first.days)).toEqual([100, 101, 102]);
  });

  it("pages disjointly and completely, in newest-first reading order", () => {
    const seen = [1, 2, 3].flatMap((n) =>
      prs(releaseNotesPage(notes, n, 3).days)
    );
    expect(seen).toEqual([100, 101, 102, 200, 300, 301, 302, 303]);
  });

  it("splits a day across the boundary and keeps its operator notes on BOTH pages", () => {
    // Page 2 of 3 ends mid-2026-08-01; page 3 carries its remaining entries.
    const second = releaseNotesPage(notes, 2, 3);
    const third = releaseNotesPage(notes, 3, 3);
    const splitOn = (p: typeof second) =>
      p.days.find((d) => d.date === "2026-08-01");
    expect(splitOn(second)?.entries.map((e) => e.pr)).toEqual([300, 301]);
    expect(splitOn(third)?.entries.map((e) => e.pr)).toEqual([302, 303]);
    // The one-time upgrade action is not hidden behind a page boundary.
    expect(splitOn(second)?.operatorNotes).toEqual(["run Y"]);
    expect(splitOn(third)?.operatorNotes).toEqual(["run Y"]);
  });

  it("clamps a page past the end, and answers an empty file as page 1 of 1", () => {
    expect(releaseNotesPage(notes, 99, 3).page).toBe(3);
    const empty = releaseNotesPage({ days: [] }, 4);
    expect(empty).toMatchObject({ page: 1, pageCount: 1, total: 0, shown: 0 });
    expect(empty.days).toEqual([]);
  });

  it("bounds the SHIPPED file — the page is a page, not the whole changelog", () => {
    const shippedNotes = loadReleaseNotes();
    const first = releaseNotesPage(shippedNotes, 1);
    expect(first.shown).toBeLessThanOrEqual(WHATS_NEW_PAGE_ENTRIES);
    expect(first.total).toBe(
      shippedNotes.days.reduce((n, d) => n + d.entries.length, 0)
    );
    // The newest day leads page 1: "what did the image I just pulled bring me".
    expect(first.days[0].date).toBe(shippedNotes.days[0].date);
  });
});

// THE CATEGORIZED, TIGHTER CONTRACT (owner, 2026-08-31): days from
// CATEGORIZED_SINCE require a category from the closed list and an ≤80-char
// title; earlier days keep the contract they shipped under. Grouping renders
// MOST VISIBLE FIRST — the arithmetic is pure, so it is pinned here.
describe("categories and the concise contract", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    pr: 1,
    title: "T",
    issues: [],
    ...over,
  });

  it("requires a category from the cutoff day, not before", () => {
    expect(() =>
      parseReleaseNotes({
        days: [day({ date: CATEGORIZED_SINCE, entries: [entry()] })],
      })
    ).toThrow(/category/);
    expect(() =>
      parseReleaseNotes({
        days: [day({ date: "2026-08-30", entries: [entry()] })],
      })
    ).not.toThrow();
  });

  it("rejects a category outside the closed list, any day", () => {
    expect(() =>
      parseReleaseNotes({
        days: [day({ entries: [entry({ category: "Vibes" })] })],
      })
    ).toThrow(/expected one of/);
  });

  it("caps a cutoff-day title at CONCISE_TITLE_LENGTH; older days keep 120", () => {
    const long = "x".repeat(CONCISE_TITLE_LENGTH + 1);
    expect(() =>
      parseReleaseNotes({
        days: [
          day({
            date: CATEGORIZED_SINCE,
            entries: [entry({ title: long, category: "General" })],
          }),
        ],
      })
    ).toThrow(/at most 80/);
    expect(() =>
      parseReleaseNotes({ days: [day({ entries: [entry({ title: long })] })] })
    ).not.toThrow();
  });

  // THE DAYS TIGHTENED BY HAND, NAMED. This was keyed on `days[0]` — the
  // NEWEST day, whichever that is — and that made it a standing demand that
  // every future day meet a contract its own date may not be under. It went
  // red on correct code the moment 2026-08-30 merged ahead of 2026-08-29:
  // nothing was wrong with either day, one of them simply arrived.
  //
  // From CATEGORIZED_SINCE the validator enforces this for every day, so the
  // only days needing a pin are the two curated BEFORE the cutoff. They are
  // named. A third pre-cutoff day is not this test's business, and a
  // post-cutoff day cannot parse without already complying.
  const TIGHTENED_BEFORE_CUTOFF = ["2026-08-30", "2026-08-29"];

  it("the days hand-tightened before the cutoff still meet the tighter shape", () => {
    const notes = parseReleaseNotes(shipped);
    for (const date of TIGHTENED_BEFORE_CUTOFF) {
      const day = notes.days.find((d) => d.date === date);
      // Named, so a day that vanished from the file fails here rather than
      // passing over an empty loop.
      expect(
        day,
        `${date} is missing from lib/release-notes.json`
      ).toBeDefined();
      expect(date < CATEGORIZED_SINCE).toBe(true);
      for (const e of day!.entries) {
        expect(e.category).toBeDefined();
        expect(e.title.length).toBeLessThanOrEqual(CONCISE_TITLE_LENGTH);
      }
    }
  });
});

describe("groupDayEntries — most visible first", () => {
  const e = (
    pr: number,
    category: string | undefined,
    kind?: string
  ): Record<string, unknown> => ({
    pr,
    title: `t${pr}`,
    issues: [],
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
  });
  const parsedDay = (entries: Record<string, unknown>[]) =>
    parseReleaseNotes({ days: [day({ entries })] }).days[0];

  it("a group holding a feature outranks fix-only groups, whatever the file order", () => {
    const groups = groupDayEntries(
      parsedDay([
        e(1, "Interface", "fix"),
        e(2, "Training", "feature"),
        e(3, "Interface", "fix"),
      ])
    );
    expect(groups.map((g) => g.category)).toEqual(["Training", "Interface"]);
  });

  it("inside a group, features lead and file order breaks ties", () => {
    const groups = groupDayEntries(
      parsedDay([
        e(1, "Training", "fix"),
        e(2, "Training", "feature"),
        e(3, "Training", "fix"),
      ])
    );
    expect(groups[0].entries.map((x) => x.entry.pr)).toEqual([2, 1, 3]);
    // Positions survive reordering, so render keys stay unique and stable.
    expect(groups[0].entries.map((x) => x.position)).toEqual([1, 0, 2]);
  });

  // THE TIE-BREAK IS ASSERTED WHERE IT DISAGREES WITH DECLARATION ORDER, which
  // is the only place it can be observed. This used to give Training the extra
  // feature — and Training is declared FIRST, so `["Training", "Sleep"]` is
  // equally what declaration order alone produces and the case could not fail.
  // Sleep is declared fifth, so giving SLEEP the extra feature makes the two
  // keys disagree and only the count can produce this answer.
  it("equally visible groups tie-break by feature count, then declaration order", () => {
    const groups = groupDayEntries(
      parsedDay([
        e(1, "Training", "feature"),
        e(2, "Sleep", "feature"),
        e(3, "Sleep", "feature"),
      ])
    );
    expect(groups.map((g) => g.category)).toEqual(["Sleep", "Training"]);
    // And with the counts level, declaration order decides — Training first.
    const declared = groupDayEntries(
      parsedDay([e(1, "Sleep", "feature"), e(2, "Training", "feature")])
    );
    expect(declared.map((g) => g.category)).toEqual(["Training", "Sleep"]);
    // The count is FEATURES, not "whatever ranks first". A security entry is
    // the most visible thing a group can hold, so it wins `best` — but it must
    // not also be counted as a capability: Sleep's two features outrank
    // Training's one inside the tier they share.
    const notSecurity = groupDayEntries(
      parsedDay([
        e(1, "Training", "security"),
        e(2, "Training", "feature"),
        e(3, "Sleep", "security"),
        e(4, "Sleep", "feature"),
        e(5, "Sleep", "feature"),
      ])
    );
    expect(notSecurity.map((g) => g.category)).toEqual(["Sleep", "Training"]);
  });

  // A LEGACY DAY IS NOT RE-ORDERED. This case used to assert [2, 1] — the
  // feature pulled ahead of the fix — which encoded the very re-ordering the
  // function's own doc, lib/release-notes.ts and the page all promise does not
  // happen to a pre-CATEGORIZED_SINCE day. Measured against the shipped file,
  // that sort moved 32 of 36 days, and on three of them it took a `security`
  // bullet its author had put FIRST and rendered it last. Curated order is the
  // author's order.
  it("a legacy day without categories is ONE headerless group, in FILE order", () => {
    const groups = groupDayEntries(
      parsedDay([e(1, undefined, "fix"), e(2, undefined, "feature")])
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
    expect(groups[0].entries.map((x) => x.entry.pr)).toEqual([1, 2]);
  });

  // The converse, so "file order" cannot pass by the sort simply being absent:
  // a CATEGORIZED day still re-orders, and security leads it.
  it("security leads a categorized group, ahead of a feature", () => {
    const groups = groupDayEntries(
      parsedDay([
        e(1, "Interface", "fix"),
        e(2, "Interface", "feature"),
        e(3, "Interface", "security"),
      ])
    );
    expect(groups[0].entries.map((x) => x.entry.pr)).toEqual([3, 2, 1]);
  });

  // And no shipped day loses its author's ordering to the group sort: only the
  // two hand-categorized days re-order, and they asked to.
  it("no legacy day in the shipped file is re-ordered", () => {
    const notes = parseReleaseNotes(shipped);
    const moved = notes.days
      .filter((day) => day.entries.some((entry) => !entry.category))
      .filter((day) => {
        const rendered = groupDayEntries(day).flatMap((g) =>
          g.entries.map((x) => x.position)
        );
        return rendered.some((position, index) => position !== index);
      })
      .map((day) => day.date);
    expect(moved).toEqual([]);
  });
});
