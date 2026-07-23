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
// The id list a set-based reader receives MUST originate from a resolved
// `ProfileScope` (`scope.ids` or a subset of `scope.viewIds`) — the ONLY legitimate
// IN-list source, already ∩ the caller's accessible set. A registered module is the
// place that promise is kept; registering a module asserts it upholds it.
//
// SCOPE LIMIT (the per-profile-context trap, #1095/#1096): set-based SQL is reserved
// for FLAT record lists. Anything derived from a per-profile `today()`/timezone, week
// mode, dueness window, or age gate must stay per-profile-COMPOSED (the loop
// assembly) — a cross-profile reader must never evaluate one member's window in
// another member's context.

// The bound-parameter placeholder tuple for a cross-profile IN-list. The caller
// writes the literal `profile_id IN ${profileIdsIn(ids)}` (so the scanner sees the
// `profile_id IN` shape and enforces the registered-module rule) and passes `...ids`
// as the bound params. NEVER interpolate ids into SQL directly.
//
// The empty set yields `(NULL)` — `IN (NULL)` binds nothing and matches NOTHING (a
// cross-profile query over no profiles must return nothing, never everything), and
// stays valid SQL (a bare `IN ()` is a syntax error). Callers that can pass an empty
// set should still short-circuit to `[]` before querying.
export function profileIdsIn(ids: readonly number[]): string {
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
export const CROSS_PROFILE_SQL_MODULES: readonly string[] = [];

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
