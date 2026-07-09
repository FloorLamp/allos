// Grant-matrix helpers for the family admin UI (issue #67, Phase 4). A member
// login's profile access lives in login_profiles; the admin screen submits
// the full set of profile ids that should be granted, and the action reconciles
// it against what's stored. Kept as a pure function so it's unit-testable without
// a DB (see lib/__tests__/grants.test.ts).

// Normalize a submitted selection: coerce to positive integers, dedupe, and keep
// only ids that are real profiles. Order-independent.
export function normalizeGrantSelection(
  submitted: readonly number[],
  validProfileIds: readonly number[]
): number[] {
  const valid = new Set(validProfileIds);
  const out = new Set<number>();
  for (const id of submitted) {
    if (Number.isInteger(id) && id > 0 && valid.has(id)) out.add(id);
  }
  return [...out].sort((a, b) => a - b);
}

// Diff a member's current grants against the desired set, returning the ids to
// insert and to delete. Used so the action only touches changed rows.
export function diffGrants(
  current: readonly number[],
  desired: readonly number[]
): { add: number[]; remove: number[] } {
  const cur = new Set(current);
  const des = new Set(desired);
  const add = [...des].filter((id) => !cur.has(id)).sort((a, b) => a - b);
  const remove = [...cur].filter((id) => !des.has(id)).sort((a, b) => a - b);
  return { add, remove };
}
