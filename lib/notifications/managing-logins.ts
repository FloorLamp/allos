// The ONE definition of "who manages this profile for notifications" — the login↔
// profile edge set that both notification DIRECTIONS must agree on (issue #1365).
//
// A notification CHANNEL belongs to a LOGIN, a per-profile EVENT is ABOUT a profile
// (see fan-out.ts). The set of logins that MANAGE a profile is the same whether we
// are fanning an event OUT to channels (managingLoginIdsForProfile → recipients) or
// resolving an inbound tap IN from a chat (profilesManagedByLogin → the profiles a
// chat's login may act on). Before #1365 these two directions were forked: outbound
// unioned the login's OWN profile (`logins.own_profile_id`, #1013), inbound joined
// only `login_profiles`, so a login whose access to a profile came ONLY via its
// own-profile association RECEIVED that profile's notifications but had every inbound
// tap silently refused. Per the identity-family / one-computation convention, the
// edge set now lives here ONCE, as an inverse pair over the SAME relation, and both
// directions read it — a change to what "manages" means can never again drift.
//
// THE EDGE SET: explicit `login_profiles` grants UNION the login whose OWN profile
// this is (`logins.own_profile_id`, #1013). Admin role is deliberately NOT a source
// — an admin who can act as every profile must NOT receive every profile's dose
// reminders (fan-out.ts's "the one deliberate departure from admin-sees-all"); they
// opt profiles into their notification scope via an explicit grant or their own-
// profile association. These reads touch login/grant tables (login_profiles, logins)
// — NOT profile-owned data — so they are not (and cannot be) profile_id-scoped in the
// owned-table sense; the profile filter lives in the query itself. Auth-blind: these
// are the raw relation, not an access check (a scope value is data, not a gate).

import { db } from "../db";

// The logins that MANAGE `profileId` — explicit grants UNION the login whose own
// profile this is. Ordered by login id so "first login wins" in the chat dedup is
// stable, and DISTINCT so a login granted AND owning the profile appears once.
export function managingLoginIdsForProfile(profileId: number): number[] {
  const rows = db
    .prepare(
      `SELECT login_id FROM login_profiles WHERE profile_id = ?
       UNION
       SELECT id AS login_id FROM logins WHERE own_profile_id = ?
       ORDER BY login_id`
    )
    .all(profileId, profileId) as { login_id: number }[];
  return rows.map((r) => r.login_id);
}

// The profiles a LOGIN manages — the exact inverse of managingLoginIdsForProfile
// over the same edge set: explicit grants UNION the login's own profile (#1013).
// Ordered by profile id and DISTINCT so a profile both granted and owned appears
// once. This is the inbound half of #1365: chat → login → the profiles that login
// may act on for an inbound Telegram tap.
export function profilesManagedByLogin(loginId: number): number[] {
  const rows = db
    .prepare(
      `SELECT profile_id FROM login_profiles WHERE login_id = ?
       UNION
       SELECT own_profile_id AS profile_id FROM logins
         WHERE id = ? AND own_profile_id IS NOT NULL
       ORDER BY profile_id`
    )
    .all(loginId, loginId) as { profile_id: number }[];
  return rows.map((r) => r.profile_id);
}
