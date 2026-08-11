// Pure decision/formatting helpers for the Family admin screen
// (app/(app)/settings/family/FamilyManager.tsx). No React, no DB — grant-matrix
// selection math, the member-grant projection a profile deletion consults, and
// the deletion-summary copy, so the component keeps only state + JSX. Unit
// tested in lib/__tests__/family-ui.test.ts; the access-diffing half lives in
// lib/grants.ts and the deletion guards in lib/family-deletion.ts.

import { grantSignature, type Access } from "@/lib/grants";
import { plural } from "@/lib/plural";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";

// `plural` used to be defined here. It's domain-free copy machinery, so it moved
// to lib/plural.ts (#1447) — re-exported so this module's existing callers and
// tests keep importing it from where they always have.
export { plural };

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

// The itemized "This erases …" clause for a profile-deletion confirmation, or a
// generic fallback when the per-profile counts haven't loaded.
export function deletionErasesText(
  summary:
    | {
        activities: number;
        bodyMetrics: number;
        clinicalObservations: number;
        documents: number;
      }
    | undefined
): string {
  if (!summary) return "all of this profile's data";
  return (
    `${summary.activities} ${plural(summary.activities, "activity", "activities")}, ` +
    `${summary.bodyMetrics} ${plural(summary.bodyMetrics, "body metric", "body metrics")}, ` +
    `${summary.clinicalObservations} clinical ${plural(summary.clinicalObservations, "observation", "observations")}, ` +
    `and ${summary.documents} ${plural(summary.documents, "document", "documents")}`
  );
}

// ---- Profile choice labels (issue #1434 part D / the #534 rule) ----

// The label for every profile a grant/access control offers — the ONE place the
// Family screen turns profile rows into choosable options. Profile names carry no
// uniqueness constraint, so two "Jordan" profiles otherwise render as identical
// checkbox rows in exactly the place where granting the wrong one matters most.
// Runs the same `disambiguateProfileNames` the switcher and household chips use, so
// a profile reads with the SAME distinguishing ordinal everywhere it can be picked.
// Order is preserved (the caller's id order); only the label changes.
export function profileChoiceLabels<T extends { id: number; name: string }>(
  profiles: readonly T[]
): { id: number; label: string; profile: T }[] {
  const labels = disambiguateProfileNames(profiles);
  return profiles.map((p) => ({
    id: p.id,
    label: labels.get(p.id) ?? p.name,
    profile: p,
  }));
}

// The initial-access selection a new member login should default to: the profile
// that shares the username being typed, when exactly such a profile exists (issue
// #1434 part B). "Create a login for Jordan" almost always means "…who is the
// Jordan profile", so the common case needs no extra thought — but an AMBIGUOUS
// name (two "Jordan" profiles) defaults to NOTHING rather than guessing which
// person the admin meant. Comparison is the same normalization
// disambiguateProfileNames uses (case-insensitive, whitespace-collapsed).
export function defaultAccessSelection<T extends { id: number; name: string }>(
  username: string,
  profiles: readonly T[]
): number[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const key = norm(username);
  if (!key) return [];
  const matches = profiles.filter((p) => norm(p.name) === key);
  return matches.length === 1 ? [matches[0].id] : [];
}

// Whether adding a profile with this name would duplicate one that already exists
// (issue #1434 part D companion). Names aren't unique-constrained — and a
// double-submit during the invite walkthrough silently created two "Jordan"
// profiles — so the create affordance asks for a soft confirmation first. A
// deliberate second "Jordan" is still allowed; it just can't happen by accident.
export function isDuplicateProfileName<T extends { name: string }>(
  name: string,
  profiles: readonly T[]
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const key = norm(name);
  if (!key) return false;
  return profiles.some((p) => norm(p.name) === key);
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
