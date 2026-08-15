// TEST-ONLY construction of the authorized-set capability (#2898).
//
// Production has NO minter that takes a list of arbitrary numbers — that absence is
// the point of `AuthorizedProfileIds`. A test that needs a fixed set (a pure test of
// `profileIdsIn`, a hand-built `ProfileScope` literal, a db fixture that seeds its own
// profiles) is standing in for an authorization boundary, and it should say so out
// loud rather than quietly casting inline. The one conversion lives here, in a module
// no production file imports.
//
// Prefer the REAL boundary wherever a test can reach one: the db-tier scope tests
// resolve an actual `ProfileScope` and read `scope.ids` / `scope.viewIds`, which is
// what proves the boundary mints the capability at all.

import type { AuthorizedProfileIds } from "@/lib/cross-profile";

export function testAuthorizedIds(
  ids: readonly number[]
): AuthorizedProfileIds {
  return ids as unknown as AuthorizedProfileIds;
}
