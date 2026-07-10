import { describe, it, expect } from "vitest";
import {
  deletionErasesText,
  grantFormEntries,
  initialGrantSelection,
  memberGrantList,
  plural,
  setGrantLevel,
  toggleGrant,
} from "@/lib/family-ui";
import type { Access } from "@/lib/grants";

describe("memberGrantList", () => {
  const logins = [
    { id: 1, username: "admin", role: "admin" as const },
    { id: 2, username: "kim", role: "member" as const },
    { id: 3, username: "sam", role: "member" as const },
  ];
  it("projects members (not admins) to their granted profile ids", () => {
    const out = memberGrantList(logins, { 2: [10, 11], 3: [] });
    expect(out).toEqual([
      { username: "kim", profileIds: [10, 11] },
      { username: "sam", profileIds: [] },
    ]);
  });
  it("defaults an ungranted member to an empty list", () => {
    expect(
      memberGrantList([{ id: 5, username: "pat", role: "member" }], {})
    ).toEqual([{ username: "pat", profileIds: [] }]);
  });
});

describe("plural", () => {
  it("picks singular only for exactly 1", () => {
    expect(plural(1, "record", "records")).toBe("record");
    expect(plural(0, "record", "records")).toBe("records");
    expect(plural(2, "record", "records")).toBe("records");
  });
});

describe("deletionErasesText", () => {
  it("itemizes counts with correct pluralization", () => {
    expect(
      deletionErasesText({
        activities: 1,
        bodyMetrics: 0,
        medicalRecords: 3,
        documents: 1,
      })
    ).toBe("1 activity, 0 body metrics, 3 medical records, and 1 document");
  });
  it("falls back generically when the summary is absent", () => {
    expect(deletionErasesText(undefined)).toBe("all of this profile's data");
  });
});

describe("grant selection transforms", () => {
  it("seeds from granted ids, defaulting unknown levels to write", () => {
    const sel = initialGrantSelection([1, 2], { 1: "read" });
    expect([...sel]).toEqual([
      [1, "read"],
      [2, "write"],
    ]);
  });
  it("toggle adds at write, then revokes, without mutating the input", () => {
    const start = new Map<number, Access>();
    const added = toggleGrant(start, 7);
    expect(start.has(7)).toBe(false); // input untouched
    expect(added.get(7)).toBe("write");
    expect(toggleGrant(added, 7).has(7)).toBe(false);
  });
  it("setGrantLevel only changes a granted profile", () => {
    const sel = new Map<number, Access>([[3, "write"]]);
    expect(setGrantLevel(sel, 3, "read").get(3)).toBe("read");
    // Ungranted id stays absent.
    expect(setGrantLevel(sel, 9, "read").has(9)).toBe(false);
  });
  it("grantFormEntries lists the selected (id, level) pairs", () => {
    const sel = new Map<number, Access>([
      [1, "write"],
      [4, "read"],
    ]);
    expect(grantFormEntries(sel)).toEqual([
      { id: 1, level: "write" },
      { id: 4, level: "read" },
    ]);
  });
});
