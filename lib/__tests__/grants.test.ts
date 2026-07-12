import { describe, it, expect } from "vitest";
import {
  normalizeGrantSelection,
  diffGrants,
  normalizeAccess,
  normalizeGrantInputs,
  diffGrantAccess,
  formatGrantDiff,
  grantSignature,
} from "../grants";

describe("normalizeGrantSelection", () => {
  it("keeps only valid, positive, integer, existing ids", () => {
    expect(normalizeGrantSelection([1, 2, 3, 99], [1, 2, 3])).toEqual([
      1, 2, 3,
    ]);
  });

  it("drops non-existent profile ids", () => {
    expect(normalizeGrantSelection([2, 5], [1, 2, 3])).toEqual([2]);
  });

  it("dedupes and sorts", () => {
    expect(normalizeGrantSelection([3, 1, 3, 1], [1, 2, 3])).toEqual([1, 3]);
  });

  it("rejects zero, negatives, and non-integers", () => {
    expect(normalizeGrantSelection([0, -1, 1.5, 2], [1, 2, 3])).toEqual([2]);
  });

  it("returns empty for an empty selection", () => {
    expect(normalizeGrantSelection([], [1, 2, 3])).toEqual([]);
  });
});

describe("diffGrants", () => {
  it("computes adds and removes", () => {
    expect(diffGrants([1, 2], [2, 3])).toEqual({ add: [3], remove: [1] });
  });

  it("is a no-op when unchanged", () => {
    expect(diffGrants([1, 2, 3], [3, 2, 1])).toEqual({ add: [], remove: [] });
  });

  it("adds all when starting from none", () => {
    expect(diffGrants([], [1, 2])).toEqual({ add: [1, 2], remove: [] });
  });

  it("removes all when clearing", () => {
    expect(diffGrants([1, 2], [])).toEqual({ add: [], remove: [1, 2] });
  });
});

// ---- Access-level grants (issue #33) ----

describe("normalizeAccess", () => {
  it("passes through 'read'", () => {
    expect(normalizeAccess("read")).toBe("read");
  });

  it("defaults anything else to 'write'", () => {
    expect(normalizeAccess("write")).toBe("write");
    expect(normalizeAccess("")).toBe("write");
    expect(normalizeAccess(null)).toBe("write");
    expect(normalizeAccess(undefined)).toBe("write");
    expect(normalizeAccess("READ")).toBe("write"); // exact match only
    expect(normalizeAccess("bogus")).toBe("write");
  });
});

describe("normalizeGrantInputs", () => {
  it("keeps valid grants, coercing access and dropping unknown profiles", () => {
    expect(
      normalizeGrantInputs(
        [
          { profileId: 1, access: "read" },
          { profileId: 2, access: "write" },
          { profileId: 99, access: "read" },
        ],
        [1, 2, 3]
      )
    ).toEqual([
      { profileId: 1, access: "read" },
      { profileId: 2, access: "write" },
    ]);
  });

  it("dedupes on profileId (last write wins) and sorts", () => {
    expect(
      normalizeGrantInputs(
        [
          { profileId: 3, access: "read" },
          { profileId: 1, access: "read" },
          { profileId: 3, access: "write" },
        ],
        [1, 2, 3]
      )
    ).toEqual([
      { profileId: 1, access: "read" },
      { profileId: 3, access: "write" },
    ]);
  });

  it("rejects zero, negative, and non-integer ids", () => {
    expect(
      normalizeGrantInputs(
        [
          { profileId: 0, access: "read" },
          { profileId: -1, access: "write" },
          { profileId: 1.5, access: "read" },
          { profileId: 2, access: "read" },
        ],
        [1, 2, 3]
      )
    ).toEqual([{ profileId: 2, access: "read" }]);
  });

  it("coerces a garbled access to 'write'", () => {
    expect(
      normalizeGrantInputs(
        [{ profileId: 1, access: "sudo" as unknown as "read" }],
        [1]
      )
    ).toEqual([{ profileId: 1, access: "write" }]);
  });
});

describe("diffGrantAccess", () => {
  it("classifies adds, level changes, and removals", () => {
    const current = [
      { profileId: 1, access: "write" as const }, // level change → update
      { profileId: 2, access: "read" as const }, // unchanged
      { profileId: 3, access: "write" as const }, // removed
    ];
    const desired = [
      { profileId: 1, access: "read" as const },
      { profileId: 2, access: "read" as const },
      { profileId: 4, access: "write" as const }, // added
    ];
    expect(diffGrantAccess(current, desired)).toEqual({
      add: [{ profileId: 4, access: "write" }],
      update: [{ profileId: 1, access: "read" }],
      remove: [3],
    });
  });

  it("is a no-op when the matrix is unchanged (order-independent)", () => {
    const current = [
      { profileId: 2, access: "read" as const },
      { profileId: 1, access: "write" as const },
    ];
    const desired = [
      { profileId: 1, access: "write" as const },
      { profileId: 2, access: "read" as const },
    ];
    expect(diffGrantAccess(current, desired)).toEqual({
      add: [],
      update: [],
      remove: [],
    });
  });

  it("adds all (with levels) when starting from none", () => {
    expect(
      diffGrantAccess(
        [],
        [
          { profileId: 1, access: "read" },
          { profileId: 2, access: "write" },
        ]
      )
    ).toEqual({
      add: [
        { profileId: 1, access: "read" },
        { profileId: 2, access: "write" },
      ],
      update: [],
      remove: [],
    });
  });
});

describe("formatGrantDiff", () => {
  it("renders a compact, id-only diff string", () => {
    expect(
      formatGrantDiff({
        add: [{ profileId: 4, access: "write" }],
        update: [{ profileId: 1, access: "read" }],
        remove: [3],
      })
    ).toBe("+4:write,~1:read,-3");
  });

  it("is empty for a no-op diff", () => {
    expect(formatGrantDiff({ add: [], update: [], remove: [] })).toBe("");
  });
});

describe("grantSignature (issue #467 optimistic concurrency)", () => {
  it("is order-independent — same grants, any order, same signature", () => {
    const a = grantSignature([
      { profileId: 3, access: "read" },
      { profileId: 1, access: "write" },
    ]);
    const b = grantSignature([
      { profileId: 1, access: "write" },
      { profileId: 3, access: "read" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a grant is added, removed, or its level flips", () => {
    const base = grantSignature([{ profileId: 1, access: "write" }]);
    expect(base).not.toBe(
      grantSignature([
        { profileId: 1, access: "write" },
        { profileId: 2, access: "write" },
      ])
    ); // added
    expect(base).not.toBe(grantSignature([])); // removed
    expect(base).not.toBe(grantSignature([{ profileId: 1, access: "read" }])); // level flip
  });

  it("signs the empty set as the empty string", () => {
    expect(grantSignature([])).toBe("");
  });

  it("normalizes access so a garbled level can't desync the two sides", () => {
    // The server reads a stored access of null/garbage as 'write' (normalizeAccess);
    // the signature must too, so an unchanged grant signs identically on both sides.
    const stored = grantSignature([
      { profileId: 1, access: "bogus" as unknown as "write" },
    ]);
    const loaded = grantSignature([{ profileId: 1, access: "write" }]);
    expect(stored).toBe(loaded);
  });
});
