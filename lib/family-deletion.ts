// Pure decision logic for the Family admin page's login/profile deletion
// (issue #67 follow-up). No DB access — the caller reads the relevant counts and
// grants and passes them in — so this stays unit-testable, and the SQL / cookie /
// redirect side effects live in the Server Action. See
// lib/__tests__/family-deletion.test.ts.

export type Decision = { ok: true } | { ok: false; reason: string };

// Whether a login may be deleted. The only hard rule is that the instance must
// keep at least one admin login, so deleting an admin is refused when it's the
// last one; members are always deletable. Deleting your OWN admin login is
// therefore allowed exactly when another admin remains — the same check, since
// `adminCount` includes the target. `adminCount` is the current number of admin
// logins (including the target when it's an admin).
export function canDeleteLogin(params: {
  role: "admin" | "member";
  adminCount: number;
}): Decision {
  if (params.role === "admin" && params.adminCount <= 1) {
    return {
      ok: false,
      reason:
        "This is the only admin login — create another admin before deleting it.",
    };
  }
  return { ok: true };
}

// Whether a profile may be deleted. Every session needs an active profile and the
// instance is meaningless with none, so deleting the last profile is refused.
// `profileCount` is the current number of profiles (including the target).
export function canDeleteProfile(params: { profileCount: number }): Decision {
  if (params.profileCount <= 1) {
    return {
      ok: false,
      reason: "This is the only profile — at least one profile must remain.",
    };
  }
  return { ok: true };
}

// Given the member logins and their granted profile ids, which members would be
// left with NO granted profile once `profileId` is removed. Such a member can no
// longer act as any profile and lands on the login gate until granted another, so
// the UI warns about them. Admins are implicit-all and must be excluded by the
// caller before passing in. Returns usernames, case-insensitively sorted.
export function membersLosingAllAccess(
  profileId: number,
  members: readonly { username: string; profileIds: readonly number[] }[]
): string[] {
  const out: string[] = [];
  for (const m of members) {
    if (!m.profileIds.includes(profileId)) continue;
    const remaining = m.profileIds.filter((id) => id !== profileId);
    if (remaining.length === 0) out.push(m.username);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
