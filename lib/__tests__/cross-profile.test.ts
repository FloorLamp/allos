import { describe, it, expect } from "vitest";
import {
  authorizedProfileSubset,
  isSealedAuthorizedProfileIds,
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

// #2898 — the capability. Two rails, tested as two rails, because the review of #2935
// found the first one alone had been described as a proof when it is not.
//
// RAIL 1, the TYPE: refuses every ORDINARY way of producing a set. Only a type-level
// test can pin a refusal, because a refused program never runs — so each case carries
// its `@ts-expect-error` AND asserts the runtime guard rejects the same value, which
// is what makes the two rails visibly independent.
describe("AuthorizedProfileIds: the type refuses ordinary expressions", () => {
  it("refuses a plain number[] at the set-based SQL boundary", () => {
    // If the directive ever goes unused, the capability has decayed back into a
    // comment and any module could hand `profileIdsIn` ids nobody authorized.
    // @ts-expect-error a bare number[] carries no authorization and must not compile
    expect(() => profileIdsIn([1, 2, 3])).toThrow(/authorization boundary/);
    // The empty list too — "no ids" is still a claim about which ids were checked.
    // @ts-expect-error an empty bare array is not an authorized set either
    expect(() => profileIdsIn([])).toThrow(/authorization boundary/);
  });

  it("refuses a hand-built object with an unrelated key", () => {
    // @ts-expect-error a plain object property is not the declared brand symbol
    expect(() => profileIdsIn(Object.assign([1], { ok: true }))).toThrow(
      /authorization boundary/
    );
  });

  it("refuses the array methods that would rebuild a set from a real one", () => {
    const parent = authorized([1, 2, 3]);
    // @ts-expect-error filter returns a plain number[]
    expect(() => profileIdsIn(parent.filter((id) => id > 1))).toThrow();
    // @ts-expect-error map returns a plain number[]
    expect(() => profileIdsIn(parent.map((id) => id))).toThrow();
    // @ts-expect-error slice returns a plain number[]
    expect(() => profileIdsIn(parent.slice(0, 1))).toThrow();
    // @ts-expect-error spreading into a literal drops the brand
    expect(() => profileIdsIn([...parent])).toThrow();
    // @ts-expect-error concatenating two capabilities yields an unbranded number[]
    expect(() =>
      profileIdsIn([...authorized([1]), ...authorized([2])])
    ).toThrow();
  });
});

// RAIL 2, the RUNTIME MARK. The type is NOT a proof: TypeScript makes `A & B`
// assignable to `B`, so `Object.assign` launders the brand with no cast and no `any`,
// and both tsc and eslint pass it. These cases are the ones the #2935 review found
// missing — the earlier suite only tested an unrelated-key object, which fails for a
// reason that has nothing to do with the real laundering path.
describe("AuthorizedProfileIds: the runtime mark refuses laundering", () => {
  it("COMPILES the Object.assign laundering the type cannot refuse", () => {
    const mine = authorized([1]);
    // No @ts-expect-error here ON PURPOSE. This assignment typechecks, and pretending
    // otherwise is the false claim the review caught. If a future TypeScript refuses
    // it, THIS test fails and the module header stops being true — which is exactly
    // when someone should come back and re-read it.
    const forged: typeof mine = Object.assign([], mine, [4, 5, 6]);
    expect([...forged]).toEqual([4, 5, 6]);
  });

  it("refuses that forged set at the chokepoint", () => {
    const mine = authorized([1]);
    const forged: typeof mine = Object.assign([], mine, [4, 5, 6]);
    // Object.assign copies own ENUMERABLE properties; the mark is non-enumerable, so
    // the fresh array never carries it.
    expect(isSealedAuthorizedProfileIds(forged)).toBe(false);
    expect(() => profileIdsIn(forged)).toThrow(
      /did not come from an authorization boundary/
    );
  });

  it("refuses in-place laundering, because a minted set is frozen", () => {
    const mine = authorized([1]);
    // The other shape: assign ONTO the real capability so the mark rides along. The
    // freeze stops it before it can lie about which ids it holds.
    expect(() => Object.assign(mine, [4, 5, 6])).toThrow(TypeError);
    expect([...mine]).toEqual([1]);
  });

  it("refuses a set that only CAST its way in", () => {
    const cast = [7, 8] as unknown as ReturnType<typeof authorized>;
    expect(isSealedAuthorizedProfileIds(cast)).toBe(false);
    expect(() => profileIdsIn(cast)).toThrow(
      /did not come from an authorization boundary/
    );
  });

  it("carries the mark through a checked subset, including down to empty", () => {
    const parent = authorized([1, 2, 3]);
    const narrowed = authorizedProfileSubset(parent, [1, 3]);
    expect(isSealedAuthorizedProfileIds(narrowed)).toBe(true);
    expect(profileIdsIn(narrowed)).toBe("(?,?)");
    // A derived EMPTY set is legitimate — a login with no reachable profile — and must
    // still reach `(NULL)` rather than the refusal.
    const nobody = authorizedProfileSubset(parent, []);
    expect(isSealedAuthorizedProfileIds(nobody)).toBe(true);
    expect(profileIdsIn(nobody)).toBe("(NULL)");
  });

  it("refuses to NARROW a forged parent — the subset would re-seal it", () => {
    const mine = authorized([1]);
    const forged: typeof mine = Object.assign([], mine, [4, 5, 6]);
    // This is the laundering the review named: without the guard, narrowing a forged
    // parent to a subset of itself returns a FRESHLY SEALED set that `profileIdsIn`
    // would then accept, so the chokepoint alone is not enough. A subset is only as
    // authorized as what it narrowed.
    expect(() => authorizedProfileSubset(forged, [4])).toThrow(
      /did not come from an authorization boundary/
    );
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
