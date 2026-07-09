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

// ---- Access-level grants (issue #33) ----

// A grant now carries an access LEVEL as well as a profile id: 'write' (read +
// edit — the historical behavior) or 'read' (view-only). These pure helpers let
// the family action reconcile the submitted matrix without a DB.
export type Access = "read" | "write";
export interface GrantInput {
  profileId: number;
  access: Access;
}

// Coerce any string to a valid access level, defaulting to the permissive
// 'write' so an absent/garbled field never accidentally locks a member out (the
// restriction to 'read' must always be explicit).
export function normalizeAccess(value: unknown): Access {
  return value === "read" ? "read" : "write";
}

// Normalize a submitted selection of (profileId, access) grants: coerce access,
// drop ids that aren't real profiles or aren't positive integers, dedupe on
// profileId (last write wins), and sort by profileId. Order-independent.
export function normalizeGrantInputs(
  submitted: readonly GrantInput[],
  validProfileIds: readonly number[]
): GrantInput[] {
  const valid = new Set(validProfileIds);
  const seen = new Map<number, Access>();
  for (const g of submitted) {
    if (
      Number.isInteger(g.profileId) &&
      g.profileId > 0 &&
      valid.has(g.profileId)
    ) {
      seen.set(g.profileId, normalizeAccess(g.access));
    }
  }
  return [...seen.entries()]
    .map(([profileId, access]) => ({ profileId, access }))
    .sort((a, b) => a.profileId - b.profileId);
}

// Diff a member's current grants (with access) against the desired set: rows to
// INSERT (newly granted), rows whose access LEVEL changed (UPDATE), and profile
// ids to REMOVE. The action only touches changed rows, so re-saving an unchanged
// matrix is a no-op.
export function diffGrantAccess(
  current: readonly GrantInput[],
  desired: readonly GrantInput[]
): { add: GrantInput[]; update: GrantInput[]; remove: number[] } {
  const cur = new Map(current.map((g) => [g.profileId, g.access]));
  const des = new Map(desired.map((g) => [g.profileId, g.access]));
  const add: GrantInput[] = [];
  const update: GrantInput[] = [];
  const remove: number[] = [];
  for (const [profileId, access] of des) {
    const before = cur.get(profileId);
    if (before === undefined) add.push({ profileId, access });
    else if (before !== access) update.push({ profileId, access });
  }
  for (const profileId of cur.keys()) {
    if (!des.has(profileId)) remove.push(profileId);
  }
  const byId = (a: GrantInput, b: GrantInput) => a.profileId - b.profileId;
  return {
    add: add.sort(byId),
    update: update.sort(byId),
    remove: remove.sort((a, b) => a - b),
  };
}

// A compact, PHI-free audit detail for a grant change: additions as
// `+<id>:<access>`, level changes as `~<id>:<access>`, removals as `-<id>`.
export function formatGrantDiff(diff: {
  add: GrantInput[];
  update: GrantInput[];
  remove: number[];
}): string {
  return [
    ...diff.add.map((g) => `+${g.profileId}:${g.access}`),
    ...diff.update.map((g) => `~${g.profileId}:${g.access}`),
    ...diff.remove.map((id) => `-${id}`),
  ].join(",");
}
