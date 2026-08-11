import { describe, it, expect } from "vitest";
import {
  defaultAccessSelection,
  deletionErasesText,
  isDuplicateProfileName,
  profileChoiceLabels,
  grantFormEntries,
  initialGrantSelection,
  loadedGrantSignature,
  memberGrantList,
  plural,
  setGrantLevel,
  toggleGrant,
} from "@/lib/family-ui";
import { grantSignature, type Access } from "@/lib/grants";

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
        clinicalObservations: 3,
        documents: 1,
      })
    ).toBe(
      "1 activity, 0 body metrics, 3 clinical observations, and 1 document"
    );
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

describe("loadedGrantSignature (issue #467)", () => {
  it("matches the server-side grantSignature for the same loaded grants", () => {
    const granted = [3, 1];
    const access: Record<number, Access> = { 1: "write", 3: "read" };
    // The client signs the (granted, access) props; the server signs the
    // GrantInput[] it reads back — the two must agree so an unchanged form passes.
    expect(loadedGrantSignature(granted, access)).toBe(
      grantSignature([
        { profileId: 1, access: "write" },
        { profileId: 3, access: "read" },
      ])
    );
  });

  it("defaults a missing access level to 'write' (mirrors the server)", () => {
    expect(loadedGrantSignature([2], {})).toBe(
      grantSignature([{ profileId: 2, access: "write" }])
    );
  });

  it("signs no grants as the empty string", () => {
    expect(loadedGrantSignature([], {})).toBe("");
  });
});

describe("profileChoiceLabels (issue #1434 / the #534 rule)", () => {
  const profiles = [
    { id: 1, name: "Jordan" },
    { id: 2, name: "Alex" },
    { id: 3, name: "jordan " },
  ];

  it("disambiguates same-named profiles wherever a grant can be picked", () => {
    // Two "Jordan" rows in the grant matrix are the costliest ambiguity on the
    // screen — they must never render identically.
    expect(profileChoiceLabels(profiles).map((c) => c.label)).toEqual([
      "Jordan (1)",
      "Alex",
      "jordan  (2)",
    ]);
  });

  it("leaves a unique name untouched and preserves the caller's order", () => {
    const out = profileChoiceLabels([
      { id: 7, name: "Sam" },
      { id: 3, name: "Kim" },
    ]);
    expect(out).toEqual([
      { id: 7, label: "Sam", profile: { id: 7, name: "Sam" } },
      { id: 3, label: "Kim", profile: { id: 3, name: "Kim" } },
    ]);
  });
});

describe("defaultAccessSelection (issue #1434)", () => {
  const profiles = [
    { id: 1, name: "Jordan" },
    { id: 2, name: "Alex" },
  ];

  it("preselects the profile that shares the username being typed", () => {
    expect(defaultAccessSelection("jordan", profiles)).toEqual([1]);
    expect(defaultAccessSelection("  Alex ", profiles)).toEqual([2]);
  });

  it("selects nothing when the name is ambiguous or unknown", () => {
    // Guessing between two same-named profiles is exactly the mistake the
    // disambiguation rule exists to prevent, so the default declines to guess.
    expect(
      defaultAccessSelection("jordan", [...profiles, { id: 3, name: "Jordan" }])
    ).toEqual([]);
    expect(defaultAccessSelection("casey", profiles)).toEqual([]);
    expect(defaultAccessSelection("", profiles)).toEqual([]);
  });
});

describe("isDuplicateProfileName (issue #1434)", () => {
  const profiles = [{ name: "Jordan" }, { name: "Alex" }];

  it("flags a name that already exists, ignoring case and spacing", () => {
    expect(isDuplicateProfileName("jordan", profiles)).toBe(true);
    expect(isDuplicateProfileName("  Jordan  ", profiles)).toBe(true);
  });

  it("does not flag a new name or an empty one", () => {
    expect(isDuplicateProfileName("Casey", profiles)).toBe(false);
    expect(isDuplicateProfileName("   ", profiles)).toBe(false);
  });
});
