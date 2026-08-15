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
// `AuthorizedProfileIds` is nominal: the brand is a `declare`d unique symbol, so no
// value expression anywhere can produce one. That makes an unauthorized id
// UNREPRESENTABLE at the set-based boundary rather than merely unlikely — a plain
// `number[]` is a compile error at `profileIdsIn`, and the only ways to hold the
// capability are:
//
//   • an authorization boundary that DERIVES the set from grants —
//     `resolveScope()`'s `ids`/`viewIds`, and lib/auth's
//     `accessibleProfileIdsForLogin` / `writableProfileIdsForLogin` for the
//     token-authenticated routes that have no session to scope;
//   • `authorizedProfileSubset(parent, wanted)` below, which can only NARROW;
//   • `authorizedSingleProfile(id)` below, which can only ever name ONE profile.
//
// There is no minter that takes a list of arbitrary numbers, and the branded arrays
// do not compose: concatenating or spreading two of them yields a plain `number[]`,
// so a cross-profile set can never be assembled out of single-profile authority.
//
// The casts this needs are the two in THIS module (both provably narrowing or
// singular) plus one inside lib/auth.ts's grant derivation. Production CALL SITES
// have none — a caller either holds a scope, narrows one, or names one profile.
//
// The CROSS_PROFILE_SQL_MODULES scan below is untouched and stays in force: it is the
// independent LOCATION backstop, answering a different question (where the shape may
// appear) from the one the type answers (whose ids it may carry). Neither replaces
// the other.
declare const AUTHORIZED_PROFILE_IDS: unique symbol;

// A set of profile ids an authorization boundary has already decided this caller may
// read TOGETHER. Assignable to `readonly number[]`, so it binds and iterates exactly
// like the list it replaces; the reverse assignment is what the brand refuses.
export type AuthorizedProfileIds = readonly number[] & {
  readonly [AUTHORIZED_PROFILE_IDS]: true;
};

// Narrow an authorized set to the members a surface actually wants. The result is
// authorized because it is a SUBSET of an already-authorized set: an id in `wanted`
// that the parent does not contain is DROPPED, never carried through, so this cannot
// widen no matter what it is handed. Parent order is preserved (the same rule
// resolveScope applies to a stored view set) so a narrowed read stays deterministic.
export function authorizedProfileSubset(
  parent: AuthorizedProfileIds,
  wanted: readonly number[]
): AuthorizedProfileIds {
  const asked = new Set(wanted);
  // Safe by construction: every surviving id was already in `parent`.
  return parent.filter((id) =>
    asked.has(id)
  ) as unknown as AuthorizedProfileIds;
}

// The ONE already-authorized profile a profile-scoped caller is running as — the
// single-active-profile model's own authority, expressed as a one-element set so a
// profile-scoped path can reach a set-based reader without inventing a scope it does
// not have (#2116's `poolIdsForProfiles([profileId])` is the case).
//
// This grants NOTHING the single-profile model does not already grant: the caller is
// a profile-scoped reader whose every other statement reads the same id through
// `WHERE profile_id = ?`, which the profile-scoping scan already governs. What it
// cannot do is widen — it takes one id and returns one id, and two of its results do
// not combine into a cross-profile set, so the multi-profile capability still comes
// only from a resolved scope.
export function authorizedSingleProfile(
  profileId: number
): AuthorizedProfileIds {
  return [profileId] as unknown as AuthorizedProfileIds;
}

// The bound-parameter placeholder tuple for a cross-profile IN-list. The caller
// writes the literal `profile_id IN ${profileIdsIn(ids)}` (so the scanner sees the
// `profile_id IN` shape and enforces the registered-module rule) and passes `...ids`
// as the bound params. NEVER interpolate ids into SQL directly.
//
// Takes the CAPABILITY, not a list: a plain `number[]` here is a compile error, so
// the provenance the comments above promise is the compiler's promise now.
//
// The empty set yields `(NULL)` — `IN (NULL)` binds nothing and matches NOTHING (a
// cross-profile query over no profiles must return nothing, never everything), and
// stays valid SQL (a bare `IN ()` is a syntax error). Callers that can pass an empty
// set should still short-circuit to `[]` before querying.
export function profileIdsIn(ids: AuthorizedProfileIds): string {
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
