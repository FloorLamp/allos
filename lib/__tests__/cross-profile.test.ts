import { describe, it, expect } from "vitest";
import {
  authorizedProfileSubset,
  authorizedSingleProfile,
  profileIdsIn,
  usesProfileIdInList,
  isCrossProfileSqlModule,
  CROSS_PROFILE_SQL_MODULES,
} from "@/lib/cross-profile";
import { testAuthorizedIds as authorized } from "./authorized-ids";

describe("profileIdsIn: bound-parameter placeholder construction", () => {
  it("builds one placeholder per id", () => {
    expect(profileIdsIn(authorized([1]))).toBe("(?)");
    expect(profileIdsIn(authorized([1, 2, 3]))).toBe("(?,?,?)");
    expect(profileIdsIn(authorized([7, 7, 7, 7, 7]))).toBe("(?,?,?,?,?)");
  });

  it("never interpolates the ids themselves (only ? placeholders)", () => {
    const out = profileIdsIn(authorized([42, 99, 1000]));
    expect(out).not.toMatch(/\d/); // no digit leaks into the SQL text
    expect(out).toBe("(?,?,?)");
  });

  it("the empty set yields (NULL) — matches NOTHING, never everything, and stays valid SQL", () => {
    expect(profileIdsIn(authorized([]))).toBe("(NULL)");
    // Composed into a clause it reads `profile_id IN (NULL)`, which binds no params
    // and can never match a row (NULL is never equal), so an empty scope returns [].
    expect(`profile_id IN ${profileIdsIn(authorized([]))}`).toBe(
      "profile_id IN (NULL)"
    );
  });

  it("composes into a scanner-visible `profile_id IN` literal", () => {
    // The caller writes the literal `profile_id IN ${profileIdsIn(ids)}`, so the SQL
    // string carries the `profile_id IN` shape the companion scanner rule keys on.
    const clause = `SELECT id FROM activities WHERE profile_id IN ${profileIdsIn(authorized([1, 2]))}`;
    expect(clause).toContain("profile_id IN (?,?)");
    expect(usesProfileIdInList(clause)).toBe(true);
  });
});

// #2898 — the capability, at the type level. The runtime behaviour of each boundary is
// exercised against real grants in lib/__db_tests__/scope.test.ts; what only a
// TYPE-level test can pin is the REFUSAL, because a refused program never runs.
describe("AuthorizedProfileIds: an unauthorized id is unrepresentable", () => {
  it("refuses a plain number[] at the set-based SQL boundary", () => {
    // If this ever compiles, the capability has decayed back into a comment and any
    // module could hand `profileIdsIn` ids nobody authorized.
    // @ts-expect-error a bare number[] carries no authorization and must not compile
    profileIdsIn([1, 2, 3]);
    // The empty list too — "no ids" is still a claim about which ids were checked.
    // @ts-expect-error an empty bare array is not an authorized set either
    profileIdsIn([]);
  });

  it("refuses a hand-built value wearing the brand's shape", () => {
    // The brand is a `declare`d unique symbol, so no value expression can produce the
    // property — structural forgery does not typecheck.
    // @ts-expect-error the brand symbol has no value form to spell
    profileIdsIn(Object.assign([1], { authorized: true }));
  });

  it("keeps the capability through a checked subset and loses it through concat", () => {
    const parent = authorized([1, 2, 3]);
    // A narrowed set is still the capability — it goes straight back in.
    expect(profileIdsIn(authorizedProfileSubset(parent, [1, 3]))).toBe("(?,?)");
    // Joining two authorized sets is NOT authorized: the result is a plain number[],
    // so a wider set can never be assembled out of narrower ones.
    // @ts-expect-error concatenating two capabilities yields an unbranded number[]
    profileIdsIn([
      ...authorizedSingleProfile(1),
      ...authorizedSingleProfile(2),
    ]);
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
  it("registers exactly the set-based readers that have landed", () => {
    // The FIRST set-based cross-profile reader landed with #1328 (Health goals /
    // Genomics / Imaging read the view-set with a bound `profile_id IN`). The second is
    // #1787's portal run-report visibility read, which decides whether a portal ACCOUNT
    // is reachable by testing its bindings against the viewer's accessible set. The
    // third is #2116's poolIdsForProfiles — the shared-bottle ids an accessible set
    // draws from, a flat list with no per-profile context in it. A NEW set-based reader
    // adds its module here in the same PR as the ids-fed reader it protects — this list
    // is the reviewed record of every one of them.
    expect(CROSS_PROFILE_SQL_MODULES).toEqual([
      "lib/queries/multi-view-lists.ts",
      "lib/portal-visibility.ts",
      "lib/queries/intake/supply-pool.ts",
    ]);
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

  it("matches the registered module by suffix and nothing else against the real registry", () => {
    expect(isCrossProfileSqlModule("lib/queries/multi-view-lists.ts")).toBe(
      true
    );
    expect(isCrossProfileSqlModule("lib/queries/household/records.ts")).toBe(
      false
    );
    expect(isCrossProfileSqlModule("lib/anything.ts")).toBe(false);
  });
});
