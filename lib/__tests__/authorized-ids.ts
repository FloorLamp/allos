// TEST-ONLY construction of the authorized-set capability (#2898).
//
// Production has NO minter that takes a list of arbitrary numbers — that absence is
// the point of `AuthorizedProfileIds`. A test that needs a fixed set (a pure test of
// `profileIdsIn`, a hand-built `ProfileScope` literal, a db fixture that seeds its own
// profiles) is standing in for an authorization boundary, and it should say so out
// loud rather than quietly forging one inline. The one stand-in lives here, in a
// module no production file imports.
//
// It performs the same SEAL a real derivation does — the non-enumerable mark plus the
// freeze — because `profileIdsIn` refuses an unsealed set at RUNTIME, not only at the
// type level. That is deliberate: it keeps this the only forgery in the tree, so a
// test cannot accidentally "prove" laundering is harmless by laundering a set that
// the chokepoint would have refused in production.
//
// Prefer the REAL boundary wherever a test can reach one: the db-tier scope tests
// resolve an actual `ProfileScope` and read `scope.ids` / `scope.viewIds`, which is
// what proves the boundary mints the capability at all.

import {
  AUTHORIZED_PROFILE_IDS_MARK,
  type AuthorizedProfileIds,
} from "@/lib/cross-profile";

export function testAuthorizedIds(
  ids: readonly number[]
): AuthorizedProfileIds {
  Object.defineProperty(ids, AUTHORIZED_PROFILE_IDS_MARK, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(ids) as unknown as AuthorizedProfileIds;
}
