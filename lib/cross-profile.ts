// Set-based cross-profile SQL, safely (issue #1095 §3).
//
// The single-active-profile model can express a cross-profile view only by LOOPING
// the per-profile readers over each member (lib/household.ts, lib/household-history.ts)
// — it structurally avoids `WHERE profile_id IN (…)`. That loop-per-profile shape
// can't cleanly express cross-DOMAIN + cross-profile joins (the #1050/#1053
// linked-record surfaces, the #1009/#1012 merged timeline). This module is the rail
// that makes a real set-based read SAFE:
//
//   1. `profileIdsIn(ids)` builds the bound-parameter placeholder tuple, so the
//      IN-list is NEVER string-interpolated ids — the caller writes the literal
//      `profile_id IN ${profileIdsIn(ids)}` and binds `...ids`.
//   2. A set-based query already PASSES the profile-scoping scanner (its SQL names
//      `profile_id`), so the scanner gains a COMPANION rule: any `.prepare`
//      statement matching `profile_id IN` must live in a REGISTERED cross-profile
//      module (below). Everywhere else, the set-based shape fails the scan — that is
//      what keeps it from silently spreading to modules that never validated the id
//      list against the caller's grants.
//
// The id list a set-based reader receives MUST originate from an authorization
// boundary — already ∩ the caller's accessible set. Since #2898 that is a TYPE, not a
// convention: the list is an `AuthorizedProfileIds` (below), which only a boundary,
// a checked subset, or a single already-authorized profile can produce. Registering a
// module is now the independent LOCATION backstop rather than the only guarantee.
//
// SCOPE LIMIT (the per-profile-context trap, #1095/#1096): set-based SQL is reserved
// for FLAT record lists. Anything derived from a per-profile `today()`/timezone, week
// mode, dueness window, or age gate must stay per-profile-COMPOSED (the loop
// assembly) — a cross-profile reader must never evaluate one member's window in
// another member's context.

// ── The authorized-set CAPABILITY (#2898) ─────────────────────────────────────
//
// The registered-module rule above controls WHERE a set-based query may live. It says
// nothing about WHICH ids that query is allowed to see, and neither did the type:
// `profileIdsIn(ids: readonly number[])` accepted any numbers at all, so the promise
// that the list came from a resolved scope was kept by the comments above and by
// review — not by the compiler. The set-based shape is exactly the shape where that
// gap bites, because a single wrong id is a silent cross-household read rather than
// an error.
//
// So the CAPABILITY is typed, and the capability is the SET, not the id. A branded
// scalar profile id would say "someone, once, authorized this number" — which is not
// the question a cross-profile query asks. The question is "may this caller see
// exactly these people, together?", and only a set can answer it.
//
// The capability has TWO origins, and both DERIVE rather than assert:
//
//   • a grant derivation — lib/auth's `accessibleProfileIdsForLogin` /
//     `writableProfileIdsForLogin`, which recompute the set from `login_profiles`
//     every call. `resolveScope()`'s `ids` and `viewIds` come from there.
//   • `authorizedProfileSubset(parent, wanted)` below, which INTERSECTS with an
//     already-authorized parent and so can only narrow.
//
// There is deliberately no minter that takes a list of arbitrary numbers, and no
// single-profile minter either: an unchecked `authorizedSingleProfile(id)` was one,
// so a profile-scoped caller that needs the pools of ONE profile now reads it through
// single-profile `profile_id = ?` SQL (`poolIdsForProfile`) instead of manufacturing
// a one-element capability.
//
// ── WHAT THE TYPE DOES AND DOES NOT PROVE ────────────────────────────────────
//
// The brand is a `declare`d unique symbol, so no ORDINARY expression produces one:
// a bare literal, `concat`, `map`, `filter`, `slice`, spread, `Array.from`,
// `toSorted` and `with` all fail to compile at `profileIdsIn`. That is a real rail,
// but it is NOT a proof, and the difference matters enough to write down: TypeScript
// makes `A & B` assignable to `B`, so `Object.assign` launders the brand onto any
// array in one line, with no cast and no `any` —
//
//     const forged: AuthorizedProfileIds = Object.assign([], mine, [4, 5, 6]);
//
// `tsc` and eslint both pass that. No brand design resists it, because intersection
// assignability is a core language rule rather than a hole in this one.
//
// So the type is the FIRST rail and not the only one. The SECOND is a runtime mark: a
// minted set is FROZEN and carries a NON-ENUMERABLE mark, and BOTH functions that
// consume a capability — `profileIdsIn` and `authorizedProfileSubset` — refuse a set
// that does not carry it. (The subset needs its own check because it seals its own
// result: narrowing a forgery would otherwise hand back a freshly-sealed set.) That
// closes every laundering shape, because `Object.assign` copies only own ENUMERABLE
// properties:
//
//   • `Object.assign([], mine, [4,5,6])` builds a fresh array — the mark is not
//     copied, so the forged set is refused;
//   • `Object.assign(mine, [4,5,6])` tries to overwrite the minted array in place —
//     frozen, so it throws before it can lie;
//   • a bare `as unknown as AuthorizedProfileIds` cast produces an unmarked array,
//     so casting one's way in no longer works either.
//
// WHAT REMAINS: importing `AUTHORIZED_PROFILE_IDS_MARK` below and defining the
// property by hand. That is a deliberate, greppable act rather than an innocent-
// looking one-liner, and it is the same trust level the whole app already runs on
// (nothing stops a `WHERE profile_id = ?` from being handed a request value either).
// The honest summary: accidental misuse is impossible, deliberate forgery is visible.
//
// The CROSS_PROFILE_SQL_MODULES scan below is untouched and stays in force: it is the
// independent LOCATION backstop, answering a different question (where the shape may
// appear) from the one the capability answers (whose ids it may carry). Neither
// replaces the other.
declare const AUTHORIZED_PROFILE_IDS: unique symbol;

// A set of profile ids an authorization boundary has already decided this caller may
// read TOGETHER. Assignable to `readonly number[]`, so it binds and iterates exactly
// like the list it replaces; the reverse assignment is what the brand refuses.
export type AuthorizedProfileIds = readonly number[] & {
  readonly [AUTHORIZED_PROFILE_IDS]: true;
};

// The RUNTIME half of the capability. Exported ONLY because the grant derivation
// lives in lib/auth.ts (which this module must not import — the cross-profile readers
// that import this one would then pull lib/auth in behind them) and it needs to seal
// its own results. A shared SYMBOL is not a minter: it hands out no ids and performs
// no conversion, so exporting it does not reopen the "public minter that accepts
// arbitrary numbers" door #2898 closed.
export const AUTHORIZED_PROFILE_IDS_MARK: unique symbol = Symbol(
  "allos.authorizedProfileIds"
);

// Seal a DERIVED set into the capability: mark it non-enumerably (so `Object.assign`
// cannot copy the mark onto a forged array) and freeze it (so `Object.assign` cannot
// overwrite this one in place). lib/auth.ts holds its own three-line copy of this
// rather than importing it — exporting the sealer WOULD be the arbitrary-numbers
// minter, and two short copies is the price of not shipping one.
function seal(ids: readonly number[]): AuthorizedProfileIds {
  Object.defineProperty(ids, AUTHORIZED_PROFILE_IDS_MARK, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(ids) as unknown as AuthorizedProfileIds;
}

// Narrow an authorized set to the members a surface actually wants. The result is
// authorized because it is a SUBSET of an already-authorized set: an id in `wanted`
// that the parent does not contain is DROPPED, never carried through, so this cannot
// widen no matter what it is handed. Parent order is preserved (the same rule
// resolveScope applies to a stored view set) so a narrowed read stays deterministic.
//
// True when a value carries the runtime mark — i.e. it was sealed by a derivation
// rather than laundered or cast into the type. Exported for the tests that pin the
// laundering shapes; production asks this question through the two guards below.
export function isSealedAuthorizedProfileIds(ids: readonly number[]): boolean {
  return AUTHORIZED_PROFILE_IDS_MARK in ids;
}

// THE PARENT IS RE-CHECKED HERE, not only at `profileIdsIn`. This function seals its
// own result, so without the check it would launder: narrow a forged parent to a
// subset of itself and the output is a freshly-sealed set the chokepoint would then
// accept. A subset is only as authorized as what it narrowed.
export function authorizedProfileSubset(
  parent: AuthorizedProfileIds,
  wanted: readonly number[]
): AuthorizedProfileIds {
  if (!isSealedAuthorizedProfileIds(parent)) {
    throw new Error(
      "authorizedProfileSubset: parent set did not come from an authorization boundary"
    );
  }
  const asked = new Set(wanted);
  return seal(parent.filter((id) => asked.has(id)));
}

// The bound-parameter placeholder tuple for a cross-profile IN-list. The caller
// writes the literal `profile_id IN ${profileIdsIn(ids)}` (so the scanner sees the
// `profile_id IN` shape and enforces the registered-module rule) and passes `...ids`
// as the bound params. NEVER interpolate ids into SQL directly.
//
// THE CHOKEPOINT. Every set-based cross-profile read builds its IN-list here, before
// it binds anything, so refusing an unsealed set here refuses it everywhere — and it
// throws rather than returning `(NULL)`, because a set that reached this line without
// a derivation behind it is a programming error, not an empty household. A caller
// that legitimately has nobody passes a derived EMPTY set, which is sealed and
// therefore fine.
//
// The empty set yields `(NULL)` — `IN (NULL)` binds nothing and matches NOTHING (a
// cross-profile query over no profiles must return nothing, never everything), and
// stays valid SQL (a bare `IN ()` is a syntax error). Callers that can pass an empty
// set should still short-circuit to `[]` before querying.
export function profileIdsIn(ids: AuthorizedProfileIds): string {
  if (!isSealedAuthorizedProfileIds(ids)) {
    throw new Error(
      "profileIdsIn: profile-id set did not come from an authorization boundary"
    );
  }
  if (ids.length === 0) return "(NULL)";
  return `(${ids.map(() => "?").join(",")})`;
}

// The repo-relative path SUFFIXES of modules permitted to contain a `profile_id IN`
// statement — the "designated cross-profile modules". A `.prepare` naming
// `profile_id IN` anywhere else fails the companion scanner rule
// (lib/__tests__/profile-scoping.test.ts).
//
// EMPTY today by design: no set-based cross-profile reader has landed yet (the
// existing cross-profile surfaces all use the loop-per-profile assembly, so nothing
// currently needs the IN-list shape). The FIRST set-based reader — e.g. under
// `lib/queries/household/` for the #1050/#1053/#1009 consumers — registers its module
// here IN THE SAME PR, right next to the `scope.ids`-fed reader it protects. Keeping
// this empty until then makes the guarantee mechanical: the set-based shape cannot
// spread without a reviewed registry edit.
export const CROSS_PROFILE_SQL_MODULES: readonly string[] = [
  // #1328: the Tier-1 multi-view flat-list readers (Health goals / Genomics /
  // Imaging) — each a durable dated fact read straight from its table with a bound
  // `profile_id IN (…)` view-set, ids fed only from a resolved scope.viewIds. The
  // deduped / age-derived Tier-1 lists stay loop-composed (readForProfiles) and never
  // reach the set-based shape, so they don't register here.
  "lib/queries/multi-view-lists.ts",
  // #1787: the Patient portals status card's run-report reader. `portal_run_reports`
  // carries no profile_id and cannot (#1756), so the account's VISIBILITY is decided by
  // whether any of its portal_identities bindings lands on a profile the viewer can
  // reach — a bound `profile_id IN (…)` over the accessible set the page resolved at the
  // auth boundary, which is the same authority the card's `identities` list already
  // filters by. One reader, its own module, so the registry entry stays reviewable.
  "lib/portal-visibility.ts",
  // #2116: poolIdsForProfiles — "which shared bottles does this accessible set draw
  // from?". A shared bottle's takers are DIFFERENT PEOPLE by construction (the #1374
  // module header), so the question is cross-profile at its root, and the answer is a
  // FLAT list of `shared_supplies` ids with no per-profile context anywhere in it —
  // precisely what the scope limit above reserves the shape for. The ids arrive from a
  // resolved ProfileScope at every call site (the cabinet doors and the Upcoming
  // pooled-supply generator both pass an already-authorized set). It replaces a
  // SELECT-DISTINCT-per-profile loop that answered the same question one member at a
  // time.
  "lib/queries/intake/supply-pool.ts",
  // #3138: every currently-open illness row for the dashboard's authorized profile
  // set. The SQL returns flat stored rows only; coverage is partitioned afterward
  // against each profile's own local today, so no per-profile clock leaks into the
  // set-based read.
  "lib/illness-episode-store.ts",
];

// True when a repo-relative path is a registered cross-profile module. Suffix match
// (like the profile-scoping allowlist) so a nested path resolves.
export function isCrossProfileSqlModule(rel: string): boolean {
  return CROSS_PROFILE_SQL_MODULES.some((m) => rel.endsWith(m));
}

// PURE detector: does this SQL use a cross-profile `profile_id IN (…)` list? Matches
// `profile_id` as the token immediately before an `IN` keyword — so it catches both
// the literal `profile_id IN (?,?)` and the helper form `profile_id IN ${…}`, while
// NOT matching a column declaration (`profile_id INTEGER …`, no word boundary after
// IN) or an unrelated `<col> IN (subquery WHERE profile_id = ?)` (the IN there is
// preceded by another column, not profile_id).
export function usesProfileIdInList(sql: string): boolean {
  return /\bprofile_id\s+IN\b/i.test(sql);
}
