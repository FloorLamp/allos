// Grant-matrix helpers for the family admin UI. A member
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

// The `access` level a grant row should STORE, given the role of the login it
// belongs to (issue #2345). One question — "what goes in that column?" — answered
// once for both writers (createLogin and setGrants).
//
// For a MEMBER the row is what GRANTS access, so the submitted level decides:
// 'read' restricts, anything else is the permissive 'write'.
//
// For an ADMIN the row means exactly ONE thing — "notify me about this profile" —
// because access was never in question. `accessForProfile` returns 'write' for an
// admin BEFORE it reads this table, and `accessibleProfiles` never consults it at
// all (lib/auth.ts), so the column is inert for them BY CONSTRUCTION. We therefore
// store the non-restricting 'write' every other writer of an admin's row already
// uses (bootstrapAuth, migration 105): a column DEFAULT, not a decision. A
// hand-written 'read' on an admin's row still resolves 'write' — nothing reads it.
export function grantAccessForRole(
  role: "admin" | "member",
  submitted: unknown
): Access {
  return role === "admin" ? "write" : normalizeAccess(submitted);
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

// Canonical, order-independent signature of a member's grant set (issue #467). The
// admin grant form submits the signature it LOADED with; setGrants re-reads the
// login's current grants under the write lock and REFUSES (friendly reload) when they
// no longer match — so a stale form whose *desired* set predates another admin's fresh
// grant can't silently revoke it. Access levels are normalized so the two sides can't
// disagree on a missing/garbled level; the empty set is "". Same shape both the client
// (loaded snapshot) and server (current) sign, so equal state ⇒ equal signature.
export function grantSignature(grants: readonly GrantInput[]): string {
  return normalizeGrantInputs(
    grants,
    grants.map((g) => g.profileId)
  )
    .map((g) => `${g.profileId}:${g.access}`)
    .join(",");
}

// The collapsed Family grant-row summary for a member login (issue #1412): the
// "N of M profiles" line the at-rest row shows before its per-profile controls are
// expanded. Derived from the SAME granted-id list the editor loads and writes
// (one computation — the summary and the expanded grid can never disagree). `total`
// is the number of profiles the matrix would offer; N is the granted count, clamped
// to [0, total] so a stale/over-long grant list can't read "5 of 3". Pluralizes on
// the total.
export function grantCountSummary(
  granted: readonly number[],
  total: number
): string {
  const m = Math.max(0, total);
  const n = Math.min(new Set(granted).size, m);
  return `${n} of ${m} ${m === 1 ? "profile" : "profiles"}`;
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
