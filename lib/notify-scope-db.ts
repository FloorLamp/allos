// An admin's notification scope (issue #2345) — the READING half. The shape and the
// copy live in lib/notify-scope.ts; this file fills the shape.
//
// It is the projection the opt-in editor needs for ONE login: every profile it can
// offer, the rows that login currently holds, their stored access levels (for the
// #467 loaded-snapshot signature), and the login's own-profile association, which is
// already in the recipient union and therefore rendered as locked-on.
//
// Auth-blind and read-only: `logins`, `login_profiles` and `profiles` are GLOBAL
// (login/grant) tables, not profile-owned, so there is no `profile_id` filter to
// apply — the same basis as `lib/notifications/managing-logins.ts`. A scope value is
// DATA, not a gate: `setGrants` still performs the authorization for any write.

import { db } from "./db";
import { normalizeAccess, type Access } from "./grants";
import type { NotifyScope, NotifyScopeProfile } from "./notify-scope";

export function notifyScopeForLogin(loginId: number): NotifyScope {
  const profiles = db
    .prepare("SELECT id, name FROM profiles ORDER BY id")
    .all() as NotifyScopeProfile[];
  const rows = db
    .prepare(
      "SELECT profile_id AS profileId, access FROM login_profiles WHERE login_id = ? ORDER BY profile_id"
    )
    .all(loginId) as { profileId: number; access: string | null }[];
  const access: Record<number, Access> = {};
  for (const r of rows) access[r.profileId] = normalizeAccess(r.access);
  const own = db
    .prepare("SELECT own_profile_id AS ownProfileId FROM logins WHERE id = ?")
    .get(loginId) as { ownProfileId: number | null } | undefined;
  return {
    profiles,
    granted: rows.map((r) => r.profileId),
    access,
    ownProfileId: own?.ownProfileId ?? null,
  };
}
