// SERVER-ACTION TIER setup (vitest.db.config.ts `setupFiles`, runs after the db
// setup that points ALLOS_DB_PATH at a per-file temp DB). Server actions guard on
// the auth layer and revalidate Next's cache — neither of which exists in a plain
// node/vitest context — so this file mocks exactly those two boundaries and NOTHING
// else. The database stays 100% REAL (the throwaway temp DB from the db setup), so
// every test asserts against rows the action actually wrote.
//
// Why mock lib/auth (the chokepoint) rather than next/headers cookies():
//  - Actions read the acting identity ONLY through requireSession()/requireAdmin(),
//    so mocking that one module is the narrowest faithful seam: the action still
//    resolves `profile.id`/`login.id` off the returned session exactly as in prod,
//    and getUnitPrefs(login.id)/decrementSupply(profile.id)/etc. hit the real DB.
//  - The alternative (mock cookies() + seed a real sessions row) would additionally
//    drag in next/navigation's redirect() and the sliding-refresh writes for no
//    added fidelity on the write path under test.
// The harness (harness.ts) still seeds REAL logins/profiles/login_profiles rows and
// binds the mocked session to them, so login-scoped reads (unit prefs) are genuine.
//
// vi.mock in a setup file is hoisted and registered in this test file's module
// registry before the file's own imports resolve, so every action-test file picks
// up these mocks without repeating them.

import { vi } from "vitest";

// No-op spy so tests can assert an action revalidated the right paths. revalidateTag
// is stubbed too in case an action reaches for it.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// Delegate the three guards to the mutable acting-session module. The factory
// imports it lazily (async) so it reads the live binding on every call — a test's
// actAs() takes effect on the next requireSession().
vi.mock("@/lib/auth", async () => {
  const { getActingSession } = await import("./session-state");
  const { db } = await import("@/lib/db");
  // Demo-mode guard (#181): the mock applies the SAME pure predicate the real
  // requireWriteAccess() uses, reading process.env.ALLOS_DEMO_MODE each call, so a
  // demo-mode write-refusal test exercises the guard faithfully (see demo.actions.test.ts).
  const { isDemoMode, isDemoRestricted } = await import("@/lib/demo");
  // Faithful accessibility: admins reach every profile, members only their
  // granted set (login_profiles) — the same rule accessibleProfiles() enforces in
  // prod. Reads the REAL temp DB so reassign/access tests exercise genuine grants.
  const getAccessibleProfiles = () => {
    const s = getActingSession();
    const rows =
      s.login.role === "admin"
        ? (db.prepare("SELECT id, name FROM profiles ORDER BY id").all() as {
            id: number;
            name: string;
          }[])
        : (db
            .prepare(
              `SELECT p.id, p.name FROM profiles p
                 JOIN login_profiles lp ON lp.profile_id = p.id
                WHERE lp.login_id = ? ORDER BY p.id`
            )
            .all(s.login.id) as { id: number; name: string }[]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      photo_path: null,
      photo_version: 0,
    }));
  };
  return {
    requireSession: () => getActingSession(),
    // Faithful to the prod guard (issue #33): a read-only acting session is
    // rejected (prod redirects; here we throw, which surfaces as a loud failure
    // exactly like the "no session" case). Every existing actAs() defaults to
    // 'write', so this is transparent unless a test opts into a read grant.
    requireWriteAccess: () => {
      const s = getActingSession();
      if (isDemoRestricted(isDemoMode(), s.login.role)) {
        throw new Error("requireWriteAccess: blocked in demo mode");
      }
      if (s.access === "read") {
        throw new Error("requireWriteAccess: acting session is read-only");
      }
      return s;
    },
    // Faithful to the login-mutation guard (#278): same pure predicate as prod
    // (a demo-restricted login's account-management writes are refused; prod
    // redirects, here we throw loudly). No access check — login-scoped actions
    // legitimately run for read-only members.
    requireLoginWriteAccess: () => {
      const s = getActingSession();
      if (isDemoRestricted(isDemoMode(), s.login.role)) {
        throw new Error("requireLoginWriteAccess: blocked in demo mode");
      }
      return s;
    },
    // Faithful to the cross-profile write gate (issue #31): resolves the session, then
    // asserts the caller can REACH the target profile AND holds WRITE on it — accessible
    // set first (a member's grant), then accessForProfile (ungranted members default to
    // 'write', so it must never be consulted alone). Prod redirects on failure; here we
    // throw loudly. Admins pass (implicit all-write). Backs the #858 cross-profile
    // illness-hero writes (log a household member's symptom/temp/dose without switching).
    requireProfileWriteAccess: (profileId: number) => {
      const s = getActingSession();
      if (isDemoRestricted(isDemoMode(), s.login.role)) {
        throw new Error("requireProfileWriteAccess: blocked in demo mode");
      }
      if (s.login.role !== "admin") {
        const grant = db
          .prepare(
            "SELECT access FROM login_profiles WHERE login_id = ? AND profile_id = ?"
          )
          .get(s.login.id, profileId) as { access: string | null } | undefined;
        if (!grant) {
          throw new Error(
            "requireProfileWriteAccess: target profile not accessible"
          );
        }
        if (grant.access === "read") {
          throw new Error("requireProfileWriteAccess: read-only on target");
        }
      }
      return s;
    },
    requireAdmin: () => getActingSession(),
    // Session-teardown helpers some login-scoped actions call after their write
    // (change-own-password evicts other devices; the revoke actions delegate
    // here). Prod reads the live cookie token, which doesn't exist in this tier,
    // so they're inert spies — tests assert the DB writes, not the eviction.
    destroyOtherSessionsForCurrent: vi.fn(async () => {}),
    revokeSession: vi.fn(),
    getCurrentSession: () => getActingSession(),
    getAccessibleProfiles,
    // Faithful to prod accessForProfile: admins are implicit all-write; a member
    // resolves the REAL grant row from the temp DB, with anything other than an
    // explicit 'read' reading as 'write' (the permissive legacy default).
    accessForProfile: (loginId: number, role: string, profileId: number) => {
      if (role === "admin") return "write";
      const row = db
        .prepare(
          "SELECT access FROM login_profiles WHERE login_id = ? AND profile_id = ?"
        )
        .get(loginId, profileId) as { access: string | null } | undefined;
      return row?.access === "read" ? "read" : "write";
    },
    // Faithful to prod canAccessProfile: admins reach every profile, members only
    // their granted ones. Used by login-scoped actions that take a profile id
    // (e.g. the #1072 per-(login,profile) notification mute) to reject a forged id.
    canAccessProfile: (
      session: { login: { id: number; role: string } },
      profileId: number
    ) => {
      if (session.login.role === "admin") return true;
      const row = db
        .prepare(
          "SELECT 1 FROM login_profiles WHERE login_id = ? AND profile_id = ?"
        )
        .get(session.login.id, profileId);
      return row != null;
    },
  };
});
