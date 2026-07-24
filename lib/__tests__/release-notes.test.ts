import { describe, expect, it } from "vitest";
import {
  ReleaseNotesError,
  hasUnseenNotes,
  issueUrl,
  loadReleaseNotes,
  newestNoteDate,
  parseReleaseNotes,
  pullRequestUrl,
  RELEASE_NOTE_KINDS,
} from "@/lib/release-notes";
import shipped from "@/lib/release-notes.json";

// The bundled release notes (issue #1421) are hand-curated bookkeeping, so the two
// things worth pinning are: (1) the SHIPPED file actually validates — a typo in a
// release-time edit fails CI here rather than rendering a broken /whats-new — and
// (2) the ONE unread comparison shared by the page and the dot.

const day = (over: Record<string, unknown> = {}) => ({
  date: "2026-07-24",
  entries: [{ pr: 1, title: "T", body: "B", issues: [] }],
  operatorNotes: [],
  ...over,
});

describe("parseReleaseNotes", () => {
  it("accepts a well-formed file and keeps the optional kind", () => {
    const notes = parseReleaseNotes({
      days: [
        day({
          entries: [
            { pr: 12, title: "A", body: "a", kind: "fix", issues: [3, 4] },
            { pr: 13, title: "B", body: "b", issues: [] },
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
      { days: [day({ entries: [{ pr: 1, body: "b", issues: [] }] })] },
    ],
    [
      "blank body",
      {
        days: [
          day({ entries: [{ pr: 1, title: "t", body: "  ", issues: [] }] }),
        ],
      },
    ],
    [
      "non-numeric pr",
      {
        days: [
          day({ entries: [{ pr: "1", title: "t", body: "b", issues: [] }] }),
        ],
      },
    ],
    [
      "unknown kind",
      {
        days: [
          day({
            entries: [
              { pr: 1, title: "t", body: "b", kind: "chore", issues: [] },
            ],
          }),
        ],
      },
    ],
    [
      "issues not an array",
      {
        days: [day({ entries: [{ pr: 1, title: "t", body: "b", issues: 3 }] })],
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
