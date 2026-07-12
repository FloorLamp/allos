// Pure decision/formatting helpers for the Family admin screen
// (app/(app)/settings/family/FamilyManager.tsx). No React, no DB — grant-matrix
// selection math, the member-grant projection a profile deletion consults, and
// the deletion-summary copy, so the component keeps only state + JSX. Unit
// tested in lib/__tests__/family-ui.test.ts; the access-diffing half lives in
// lib/grants.ts and the deletion guards in lib/family-deletion.ts.

import { grantSignature, type Access } from "@/lib/grants";

// The member logins (with their granted profile ids) that a profile deletion
// would consult — computed from the grant matrix. Admins are excluded (they
// keep implicit all-profile access), so only members can lose their last grant.
export function memberGrantList(
  logins: readonly { id: number; username: string; role: "admin" | "member" }[],
  grants: Record<number, number[]>
): { username: string; profileIds: number[] }[] {
  return logins
    .filter((a) => a.role === "member")
    .map((a) => ({ username: a.username, profileIds: grants[a.id] ?? [] }));
}

// Tiny count-aware word picker for the deletion summary line.
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// The itemized "This erases …" clause for a profile-deletion confirmation, or a
// generic fallback when the per-profile counts haven't loaded.
export function deletionErasesText(
  summary:
    | {
        activities: number;
        bodyMetrics: number;
        medicalRecords: number;
        documents: number;
      }
    | undefined
): string {
  if (!summary) return "all of this profile's data";
  return (
    `${summary.activities} ${plural(summary.activities, "activity", "activities")}, ` +
    `${summary.bodyMetrics} ${plural(summary.bodyMetrics, "body metric", "body metrics")}, ` +
    `${summary.medicalRecords} medical ${plural(summary.medicalRecords, "record", "records")}, ` +
    `and ${summary.documents} ${plural(summary.documents, "document", "documents")}`
  );
}

// ---- Grant-matrix row selection (client state, pure transforms) ----

// The initial (profile id → access level) map for a member's grants row: each
// currently-granted profile, defaulting to 'write' when its stored level is
// unknown (mirrors the server's normalizeAccess).
export function initialGrantSelection(
  granted: readonly number[],
  access: Record<number, Access>
): Map<number, Access> {
  return new Map(granted.map((id) => [id, access[id] ?? "write"]));
}

// Toggle a profile's grant: add it at 'write' if absent, else revoke it.
// Returns a fresh map (never mutates the input) so it drops straight into a
// React setState updater.
export function toggleGrant(
  prev: Map<number, Access>,
  id: number
): Map<number, Access> {
  const next = new Map(prev);
  if (next.has(id)) next.delete(id);
  else next.set(id, "write");
  return next;
}

// Change the access level of an already-granted profile; a no-op (fresh copy)
// if the profile isn't currently granted.
export function setGrantLevel(
  prev: Map<number, Access>,
  id: number,
  level: Access
): Map<number, Access> {
  const next = new Map(prev);
  if (next.has(id)) next.set(id, level);
  return next;
}

// The (profileId, access) pairs a grants-row save submits, from its selection
// map. The component turns these into FormData fields.
export function grantFormEntries(
  selected: Map<number, Access>
): { id: number; level: Access }[] {
  return [...selected].map(([id, level]) => ({ id, level }));
}

// The signature of the grants a row LOADED with (issue #467), submitted as a hidden
// field so setGrants can refuse a stale form. Built from the same (granted, access)
// props initialGrantSelection uses, through the shared grantSignature so the client's
// loaded snapshot and the server's current read sign identically.
export function loadedGrantSignature(
  granted: readonly number[],
  access: Record<number, Access>
): string {
  return grantSignature(
    granted.map((id) => ({ profileId: id, access: access[id] ?? "write" }))
  );
}
