// ProfileScope — the first-class cross-profile access primitive (issue #1095).
//
// The app's access model is single-active-profile: `requireSession().profile.id`,
// profileId-first readers, the profile-scoping scanner. Every cross-profile surface
// (the household dashboard/history, the family calendar, the episodes index, the
// household dose cards, the reassign pickers) re-implements the SAME shape by hand:
//   getAccessibleProfiles() → loop the per-profile readers over each member →
//   accessForProfile() per write affordance → hand-stamp subject identity.
//
// This module resolves that shape ONCE at the auth boundary into a `ProfileScope`,
// and pages/actions flow it DOWN as data. It changes NO access semantics: the
// accessible set is exactly `accessibleProfilesForLogin` (members see only granted
// profiles, admins all), the per-profile access map is exactly `accessForProfile`,
// and writes still target ONE profile through `requireProfileWriteAccess`. A scope
// value is DATA — never an auth check; the boundary (requireScope) is the auth
// decision, and `scope.access` only powers read-only labels without a second lookup.
//
// Companion rails (all pure, all tested):
//   • the profileIds-list-first convention (a cross-profile reader takes `ids` and
//     never imports lib/auth) — the app-wide promotion of household-history's
//     module-local contract;
//   • `profileIdsIn` + the registered-module scanner rule for set-based
//     `WHERE profile_id IN (…)` SQL — see lib/cross-profile.ts;
//   • `stampSubjects` — one disambiguated-name/avatar resolution (#534), so no
//     surface re-implements subject identity.
//
// #1096 (multi-profile viewing + the persisted per-session view-set) and #1013 (the
// own-profile display layer) build ON this primitive; they are NOT built here. The
// scope carries the SHAPE they consume — `viewIds` (defaulting to `[actingProfileId]`
// until #1096 persists a real view-set) and `ownProfileId` (null until #1013's
// association lands) — so those PRs add data, not new plumbing.

import {
  requireSession,
  accessibleProfilesForLogin,
  accessForProfile,
  getCurrentViewProfileIds,
  ownProfileForLogin,
  type Access,
  type Role,
  type SessionProfile,
  type CurrentSession,
} from "./auth";
import { disambiguateProfileNames } from "./profile-disambiguation";

export interface ProfileScope {
  loginId: number;
  role: Role;
  // The session's active profile — the single-active-profile concept, unchanged. A
  // write with no explicit target still acts as THIS profile.
  actingProfileId: number;
  // #1013's own-profile association (logins.own_profile_id, migration 103): the
  // profile the login has marked as "mine", or null (unset / caregiver-only login).
  // Re-validated ∩ accessible on resolution, so a revoked grant reads back null.
  // Rides in the scope so the display layer (self-vs-other, not-self write labels via
  // lib/own-profile.ts) needs no second resolution.
  ownProfileId: number | null;
  // The accessible set, with DISAMBIGUATED names (#534) — the source of truth every
  // surface labels from. Ordered by id (stable "first accessible").
  profiles: SessionProfile[];
  // profiles.map(p => p.id) — the ONLY legitimate source of a cross-profile IN-list.
  ids: number[];
  // #1096's persisted view-set ∩ accessible, defaulting to [actingProfileId]. A
  // single-profile page ignores this; a multi-view page passes it to its list-first
  // readers. Validated here so an out-of-range or revoked id can never widen a view.
  viewIds: number[];
  // Per-profile read|write, resolved once. Powers read-only labels/gating WITHOUT a
  // second accessForProfile lookup — it is NOT the write gate (that stays
  // requireProfileWriteAccess at the action boundary).
  access: ReadonlyMap<number, Access>;
}

// DB-callable core: build a ProfileScope from an already-resolved session (the auth
// decision) plus an OPTIONAL raw view-set (the ids a future persisted
// sessions.view_profile_ids would carry — #1096). Split from requireScope so the
// resolution — accessible set, disambiguation, access map, and the viewIds ∩
// accessible validation — is testable without a request.
//
// `rawViewIds` is validated the ONLY safe way: intersect with the accessible ids
// (dropping anything not granted / not existing), preserve accessible order, and
// fall back to [actingProfileId] when the result is empty. So a member can never
// name a profile outside their grant into the view, and a revoked grant drops out
// of the view on the next resolution — the same "re-derive against current grants"
// stance resolveSessionToken already takes for the active profile.
export function resolveScope(
  session: CurrentSession,
  rawViewIds?: readonly number[] | null,
  ownProfileId: number | null = null
): ProfileScope {
  const { login } = session;
  const accessible = accessibleProfilesForLogin(login.id);
  const nameByProfile = disambiguateProfileNames(accessible);
  const profiles: SessionProfile[] = accessible.map((p) => ({
    ...p,
    name: nameByProfile.get(p.id) ?? p.name,
  }));
  const ids = profiles.map((p) => p.id);
  const accessibleSet = new Set(ids);

  const access = new Map<number, Access>();
  for (const id of ids) {
    access.set(id, accessForProfile(login.id, login.role, id));
  }

  const actingProfileId = session.profile.id;

  // #1013: re-validate the own-profile link against the CURRENT accessible set. An
  // association to a profile the login no longer reaches (grant revoked, profile
  // deleted before deleteProfile nulled it) resolves to null — the same "re-derive
  // against current grants" stance the active profile + view-set take. So a stale
  // stored value can never make an inaccessible profile read as "self".
  const validatedOwnProfileId =
    ownProfileId !== null && accessibleSet.has(ownProfileId)
      ? ownProfileId
      : null;

  let viewIds: number[];
  if (rawViewIds && rawViewIds.length > 0) {
    const wanted = new Set(rawViewIds.filter((id) => accessibleSet.has(id)));
    // Preserve accessible order (not the raw input's) so the view is deterministic.
    viewIds = ids.filter((id) => wanted.has(id));
    if (viewIds.length === 0) viewIds = [actingProfileId];
  } else {
    viewIds = [actingProfileId];
  }

  return {
    loginId: login.id,
    role: login.role,
    actingProfileId,
    ownProfileId: validatedOwnProfileId,
    profiles,
    ids,
    viewIds,
    access,
  };
}

// Resolve the caller's cross-profile scope at the auth boundary. One call replaces
// the getAccessibleProfiles() + per-profile accessForProfile() loops every
// cross-profile surface hand-rolls. requireSession() stays for single-profile pages
// (the overwhelmingly common case) — this ADDS a primitive, it does not move the app
// to multi-profile-by-default.
//
// `rawViewIds` is the persisted view-set hook (#1096). When the caller passes
// nothing (`undefined`), requireScope LOADS the session's persisted
// `sessions.view_profile_ids` (migration 101) and validates it here — so a
// multi-view page just calls `requireScope()` and reads `scope.viewIds`. Passing an
// explicit array (or null) overrides the persisted set for that resolution (used by
// tests and any surface that wants an ad-hoc view). The stored value is ALWAYS
// re-validated (∩ accessible) in resolveScope — never trusted as stored.
export async function requireScope(
  rawViewIds?: readonly number[] | null
): Promise<ProfileScope> {
  const session = await requireSession();
  const raw =
    rawViewIds !== undefined ? rawViewIds : await getCurrentViewProfileIds();
  // #1013: the own-profile link rides the scope so the display layer needs no second
  // resolution. Loaded from the stored value; resolveScope re-validates it ∩ accessible.
  const ownProfileId = ownProfileForLogin(session.login.id);
  return resolveScope(session, raw, ownProfileId);
}

// ── Subject stamping (#534, #531/#900) ────────────────────────────────────────

// The per-row subject identity a cross-profile surface renders: the disambiguated
// name + avatar for the row's owning profile, plus the caller's access on it (so an
// item from a read-only-granted member can render a read-only affordance without a
// second lookup). One resolution, shared — no surface re-implements it.
export interface SubjectInfo {
  profileId: number;
  name: string;
  photoPath: string | null;
  photoVersion: number;
  access: Access;
}

export type Stamped<T> = T & { subject: SubjectInfo };

// Attach subject identity to every cross-profile row from the scope's already-
// disambiguated set. PURE: no DB, no auth. A row whose profileId is not in scope
// (should not happen — a list-first reader only returns in-scope rows) falls back to
// a stable "Profile <id>" label and the most-restrictive 'read' access, so a stray
// row can never mislabel as another member or imply write it lacks.
export function stampSubjects<T extends { profileId: number }>(
  scope: ProfileScope,
  items: readonly T[]
): Stamped<T>[] {
  const byId = new Map(scope.profiles.map((p) => [p.id, p]));
  return items.map((item) => {
    const p = byId.get(item.profileId);
    return {
      ...item,
      subject: {
        profileId: item.profileId,
        name: p?.name ?? `Profile ${item.profileId}`,
        photoPath: p?.photo_path ?? null,
        photoVersion: p?.photo_version ?? 0,
        access: scope.access.get(item.profileId) ?? "read",
      },
    };
  });
}

// ── Loop-composition (#1328) ──────────────────────────────────────────────────

// readForProfiles is the PURE loop-composition helper — it lives in lib/multi-view.ts
// (no DB, unit-testable) and is re-exported here so a Section can pull it alongside
// stampSubjects from the one scope module.
export { readForProfiles } from "./multi-view";
