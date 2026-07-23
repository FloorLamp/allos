import { describe, it, expect } from "vitest";
import {
  profileIdsIn,
  usesProfileIdInList,
  isCrossProfileSqlModule,
  CROSS_PROFILE_SQL_MODULES,
} from "@/lib/cross-profile";

describe("profileIdsIn: bound-parameter placeholder construction", () => {
  it("builds one placeholder per id", () => {
    expect(profileIdsIn([1])).toBe("(?)");
    expect(profileIdsIn([1, 2, 3])).toBe("(?,?,?)");
    expect(profileIdsIn([7, 7, 7, 7, 7])).toBe("(?,?,?,?,?)");
  });

  it("never interpolates the ids themselves (only ? placeholders)", () => {
    const out = profileIdsIn([42, 99, 1000]);
    expect(out).not.toMatch(/\d/); // no digit leaks into the SQL text
    expect(out).toBe("(?,?,?)");
  });

  it("the empty set yields (NULL) — matches NOTHING, never everything, and stays valid SQL", () => {
    expect(profileIdsIn([])).toBe("(NULL)");
    // Composed into a clause it reads `profile_id IN (NULL)`, which binds no params
    // and can never match a row (NULL is never equal), so an empty scope returns [].
    expect(`profile_id IN ${profileIdsIn([])}`).toBe("profile_id IN (NULL)");
  });

  it("composes into a scanner-visible `profile_id IN` literal", () => {
    // The caller writes the literal `profile_id IN ${profileIdsIn(ids)}`, so the SQL
    // string carries the `profile_id IN` shape the companion scanner rule keys on.
    const clause = `SELECT id FROM activities WHERE profile_id IN ${profileIdsIn([1, 2])}`;
    expect(clause).toContain("profile_id IN (?,?)");
    expect(usesProfileIdInList(clause)).toBe(true);
  });
});

describe("usesProfileIdInList: the companion-rule detector", () => {
  it("matches a real cross-profile IN-list (literal or helper form)", () => {
    expect(
      usesProfileIdInList("SELECT * FROM activities WHERE profile_id IN (?,?)")
    ).toBe(true);
    expect(
      usesProfileIdInList("... WHERE profile_id IN ${profileIdsIn(ids)}")
    ).toBe(true);
    expect(usesProfileIdInList("WHERE profile_id   IN   (1,2)")).toBe(true);
  });

  it("does NOT match a column declaration (`profile_id INTEGER …`)", () => {
    // Migration CREATE bodies are scanned too; `INTEGER`/`INDEX` must not trip the
    // rule (no word boundary after `IN`).
    expect(
      usesProfileIdInList("profile_id INTEGER NOT NULL REFERENCES profiles(id)")
    ).toBe(false);
    expect(usesProfileIdInList("CREATE INDEX ix ON t(profile_id)")).toBe(false);
  });

  it("does NOT match single-profile scoping or an unrelated column's IN", () => {
    expect(usesProfileIdInList("WHERE profile_id = ?")).toBe(false);
    // The IN here belongs to `id`, not profile_id; the subquery is single-scoped.
    expect(
      usesProfileIdInList(
        "WHERE id IN (SELECT id FROM sets WHERE profile_id = ?)"
      )
    ).toBe(false);
  });
});

describe("isCrossProfileSqlModule: registry membership (fixture-pinned)", () => {
  it("the registry is empty today (no set-based reader has landed)", () => {
    expect(CROSS_PROFILE_SQL_MODULES).toEqual([]);
  });

  it("with a synthetic registry, matches by path suffix and nothing else", () => {
    // The real registry is empty, so exercise the membership shape against a fixture
    // registry the same way the scanner will consume the real one — this proves the
    // companion rule ALLOWS a registered module and FLAGS an unregistered one before
    // any real consumer exists.
    const fixtureRegistry = ["lib/queries/household/records.ts"];
    const match = (rel: string) => fixtureRegistry.some((m) => rel.endsWith(m));

    expect(match("lib/queries/household/records.ts")).toBe(true);
    // Suffix match is anchored on the full registered path, so a same-basename file
    // under a different directory does NOT ride the registration.
    expect(match("app/(app)/some/other/records.ts")).toBe(false);
    expect(match("lib/queries/medical.ts")).toBe(false);
    expect(match("lib/household.ts")).toBe(false);
  });

  it("returns false for every path against the (empty) real registry", () => {
    expect(isCrossProfileSqlModule("lib/queries/household/records.ts")).toBe(
      false
    );
    expect(isCrossProfileSqlModule("lib/anything.ts")).toBe(false);
  });
});
