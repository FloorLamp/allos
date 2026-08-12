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

import { beforeAll, vi } from "vitest";
import * as cacheSpies from "./cache-spies";
import { clearActingSession } from "./session-state";

// No-op spies so tests can assert an action revalidated the right paths.
// revalidateTag is stubbed too in case an action reaches for it.
//
// The factory returns the SHARED instances from ./cache-spies rather than minting
// vi.fn()s inline: it re-runs per test file, and under a shared module registry
// (vitest.db.config.ts's db-shared project) fresh spies would leave the already
// imported server actions calling the previous ones. See that file for the full
// reasoning.
vi.mock("next/cache", async () => {
  const spies = await import("./cache-spies");
  return {
    revalidatePath: spies.revalidatePath,
    revalidateTag: spies.revalidateTag,
  };
});

// Per FILE, not per test. A fresh registry used to hand each file brand-new spies
// whose calls then accumulated across that file's tests; clearing here reproduces
// that exactly. Clearing per test would be a stricter rule than the suite was
// written against — a spec that acts in beforeAll and asserts in several `it`s
// would start failing for a reason that has nothing to do with its subject.
beforeAll(() => {
  cacheSpies.revalidatePath.mockClear();
  cacheSpies.revalidateTag.mockClear();
  // session-state is a module too, so a shared registry carries the previous
  // file's acting session into this one. That would silently defeat the guard in
  // getActingSession(): a spec that forgot to call actAs() is supposed to fail
  // loudly, not quietly run as whoever the last file signed in as. Clearing here
  // restores the fresh-registry starting point — null — for every file.
  clearActingSession();
});

// Delegate the three guards to the mutable acting-session module. The factory
// imports it lazily (async) so it reads the live binding on every call — a test's
// actAs() takes effect on the next requireSession().
vi.mock("@/lib/auth", async () => {
  const { getActingSession, peekActingSession } =
    await import("./session-state");
  // Held as a MODULE, not destructured: the shared-registry tier
  // (vitest.db-shared.config.ts) rebinds lib/db.ts's `db` export between test
  // files, and a destructured snapshot would keep querying the file before it.
  // Reading dbMod.db per call follows the live binding in both tiers.
  const dbMod = await import("@/lib/db");
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
        ? (dbMod.db
            .prepare("SELECT id, name FROM profiles ORDER BY id")
            .all() as {
            id: number;
            name: string;
          }[])
        : (dbMod.db
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
        const grant = dbMod.db
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
    // Faithful to prod requireAdmin: a non-admin is bounced (redirect("/") throws
    // NEXT_REDIRECT in prod; a recognizable marker here), so an action test can assert
    // an admin-only gate refuses a member — #1875 made that observable behaviour worth
    // pinning in this tier rather than leaving it to the static scan alone.
    requireAdmin: () => {
      const s = getActingSession();
      if (s.login.role !== "admin") {
        throw new Error("NEXT_REDIRECT: requireAdmin refused a non-admin");
      }
      return s;
    },
    // The persisted cross-profile VIEW (#1331). Prod reads it off the view cookie;
    // this tier has no cookie, and null is exactly what prod returns for a session
    // that has not chosen one — resolveScope then scopes to the acting profile
    // alone, so a requireScope()-gated action runs in single view here.
    getCurrentViewProfileIds: async () => null,
    // Session-teardown helpers some login-scoped actions call after their write
    // (change-own-password evicts other devices; the revoke actions delegate
    // here). Prod reads the live cookie token, which doesn't exist in this tier,
    // so they're inert spies — tests assert the DB writes, not the eviction.
    destroyOtherSessionsForCurrent: vi.fn(async () => {}),
    revokeSession: vi.fn(),
    // The NON-throwing read (prod returns null for an anonymous request), so a
    // route handler's "no session" branch is testable: a test calls
    // clearActingSession() and asserts the handler's own refusal.
    getCurrentSession: () => peekActingSession(),
    getAccessibleProfiles,
    // Faithful to prod accessibleProfilesForLogin: the session-FREE reader, resolving
    // an ARBITRARY login's role + grants from the temp DB (not the acting session's).
    // Actions that resolve some OTHER login's reach need this — e.g. the #1459
    // household round, whose offer set is "the profiles the receiving profile's own
    // login can write". Same rule as accessibleProfiles(): admins reach every profile,
    // members only their granted set.
    accessibleProfilesForLogin: (loginId: number) => {
      const acct = dbMod.db
        .prepare("SELECT role FROM logins WHERE id = ?")
        .get(loginId) as { role: string } | undefined;
      if (!acct) return [];
      const rows =
        acct.role === "admin"
          ? (dbMod.db
              .prepare("SELECT id, name FROM profiles ORDER BY id")
              .all() as {
              id: number;
              name: string;
            }[])
          : (dbMod.db
              .prepare(
                `SELECT p.id, p.name FROM profiles p
                   JOIN login_profiles lp ON lp.profile_id = p.id
                  WHERE lp.login_id = ? ORDER BY p.id`
              )
              .all(loginId) as { id: number; name: string }[]);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        photo_path: null,
        photo_version: 0,
      }));
    },
    // Faithful to prod accessForProfile: admins are implicit all-write; a member
    // resolves the REAL grant row from the temp DB, with anything other than an
    // explicit 'read' reading as 'write' (the permissive legacy default).
    accessForProfile: (loginId: number, role: string, profileId: number) => {
      if (role === "admin") return "write";
      const row = dbMod.db
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
      const row = dbMod.db
        .prepare(
          "SELECT 1 FROM login_profiles WHERE login_id = ? AND profile_id = ?"
        )
        .get(session.login.id, profileId);
      return row != null;
    },
    // The instance-wide admin census. Faithful: a real COUNT over the temp DB's
    // logins, using the SAME sql text lib/auth uses, so deleteLogin's last-admin
    // guard is exercised against genuine rows — and issue #2108's assertion that
    // the count is read INSIDE the write transaction can observe the statement.
    adminLoginCount: () =>
      (
        dbMod.db
          .prepare("SELECT COUNT(*) AS c FROM logins WHERE role = 'admin'")
          .get() as { c: number }
      ).c,
    // Own-profile association (issue #1013). Faithful to the real core: the reader
    // returns the stored id from the REAL temp DB; the setter enforces the same
    // accessibility constraint (admins reach every profile, members only granted)
    // before writing, returning false (no-op) for an inaccessible target.
    ownProfileForLogin: (loginId: number) => {
      const row = dbMod.db
        .prepare("SELECT own_profile_id AS o FROM logins WHERE id = ?")
        .get(loginId) as { o: number | null } | undefined;
      return row?.o ?? null;
    },
    setOwnProfileForLogin: (
      loginId: number,
      role: string,
      profileId: number | null
    ) => {
      if (profileId !== null) {
        const reachable =
          role === "admin"
            ? (dbMod.db
                .prepare("SELECT id FROM profiles WHERE id = ?")
                .get(profileId) as { id: number } | undefined)
            : (dbMod.db
                .prepare(
                  "SELECT profile_id AS id FROM login_profiles WHERE login_id = ? AND profile_id = ?"
                )
                .get(loginId, profileId) as { id: number } | undefined);
        if (!reachable) return false;
      }
      dbMod.db
        .prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?")
        .run(profileId, loginId);
      return true;
    },
  };
});
