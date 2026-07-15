// DB INTEGRATION TIER — the auth core (lib/auth.ts + lib/two-factor.ts) against a
// real in-memory SQLite handle (issue #676). These modules were at ~0% before:
// their decision logic is request-coupled (getCurrentSession/setActiveProfile read
// cookies(), the guards redirect()), so the coverable logic was extracted into
// DB-callable cores — resolveSessionToken() and switchActiveProfile() — which the
// cookie/redirect shells now delegate to. This suite drives those cores plus the
// already-DB-callable helpers (createSession, purgeExpiredSessions,
// destroyLoginSessions, revokeSession, accessForProfile, accessibleProfilesForLogin)
// and every function in lib/two-factor.ts.
//
// Cookie ATTRIBUTES are pinned separately as a pure test
// (lib/__tests__/session-cookie.test.ts); the cookie/redirect SHELLS themselves are
// deliberately not exercised here (no request), only the cores they delegate to.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import crypto from "node:crypto";

// This DB tier's shared setup (vitest.db.config.ts) mocks @/lib/auth for the
// server-action suite. THIS suite is about lib/auth itself, so restore the real
// module for this file only (per-file module registry — other files keep the mock).
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db } from "@/lib/db";
import {
  resolveSessionToken,
  switchActiveProfile,
  createSession,
  purgeExpiredSessions,
  destroyLoginSessions,
  revokeSession,
  accessForProfile,
  accessibleProfilesForLogin,
  adminLoginCount,
  canAccessProfile,
  type CurrentSession,
} from "@/lib/auth";
import {
  beginTotpEnrollment,
  activateTotp,
  isTotpEnabled,
  getLoginTotpState,
  verifyLoginSecondFactor,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  disableTotp,
  is2faBypassed,
  createTotpChallenge,
  getTotpChallenge,
  deleteTotpChallenge,
  purgeExpiredTotpChallenges,
} from "@/lib/two-factor";
import { totp, TOTP_STEP_SECONDS } from "@/lib/totp";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { recordAudit } from "@/lib/audit";

const STEP_MS = TOTP_STEP_SECONDS * 1000;

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

let seq = 0;
function mkLogin(role: "admin" | "member" = "member"): {
  id: number;
  username: string;
} {
  const username = `user_${role}_${++seq}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(username, role).lastInsertRowid
  );
  return { id, username };
}

function mkProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function grant(
  loginId: number,
  profileId: number,
  access: "read" | "write" = "write"
): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

// Backdate a session's timestamps by SQLite datetime modifiers (e.g. '-91 days').
function ageSession(
  tokenHash: string,
  createdMod: string,
  expiresMod: string,
  lastUsedMod: string
): void {
  db.prepare(
    `UPDATE sessions
        SET created_at = datetime('now', ?),
            expires_at = datetime('now', ?),
            last_used_at = datetime('now', ?)
      WHERE token_hash = ?`
  ).run(createdMod, expiresMod, lastUsedMod, tokenHash);
}

function sessionRow(tokenHash: string) {
  return db
    .prepare(
      "SELECT active_profile_id AS activeProfileId, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt FROM sessions WHERE token_hash = ?"
    )
    .get(tokenHash) as
    | {
        activeProfileId: number | null;
        createdAt: string;
        expiresAt: string;
        lastUsedAt: string;
      }
    | undefined;
}

function countSessions(loginId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE login_id = ?")
      .get(loginId) as { n: number }
  ).n;
}

beforeEach(() => {
  // Wipe the per-request/session state each test creates. Order is FK-safe
  // (foreign_keys is ON): sessions/challenges/recovery/grants before their
  // parents. Logins + profiles accumulate harmlessly across tests — every test
  // mints fresh, uniquely-named ones, so leftover rows never collide with the ids
  // under assertion (and the few instance-wide reads assert relative to a baseline).
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM login_totp_challenges").run();
  db.prepare("DELETE FROM login_recovery_codes").run();
  db.prepare("DELETE FROM login_profiles").run();
  db.prepare("DELETE FROM audit_events").run();
});

describe("session lifecycle", () => {
  it("mints a session and resolves it by its hashed token", () => {
    const { id } = mkLogin();
    const profileId = mkProfile("Ada Lovelace");
    grant(id, profileId);

    const { token, maxAgeSec } = createSession(id, "test-agent");
    expect(maxAgeSec).toBe(30 * 24 * 60 * 60);
    // The DB stores only the SHA-256 of the token, never the token itself.
    const stored = db
      .prepare("SELECT token_hash, user_agent FROM sessions WHERE login_id = ?")
      .get(id) as { token_hash: string; user_agent: string };
    expect(stored.token_hash).toBe(sha256hex(token));
    expect(stored.token_hash).not.toBe(token);
    expect(stored.user_agent).toBe("test-agent");

    const session = resolveSessionToken(token);
    expect(session).not.toBeNull();
    expect(session!.login.id).toBe(id);
    expect(session!.profile.id).toBe(profileId);
    expect(session!.access).toBe("write");
  });

  it("returns null for an unknown / garbage token", () => {
    expect(resolveSessionToken("not-a-real-token")).toBeNull();
  });

  it("returns null when the login has no usable profile", () => {
    const { id } = mkLogin(); // member with no grants
    const { token } = createSession(id);
    expect(resolveSessionToken(token)).toBeNull();
  });

  it("slides expires_at forward on resolution once the session is >1h stale", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Grace Hopper"));
    const { token } = createSession(id);
    const tokenHash = sha256hex(token);
    // Simulate a session last used 2h ago whose expiry has wound down to +5 days.
    ageSession(tokenHash, "-2 hours", "+5 days", "-2 hours");
    const before = sessionRow(tokenHash)!;

    expect(resolveSessionToken(token)).not.toBeNull();

    const after = sessionRow(tokenHash)!;
    // Sliding refresh re-extended expires_at (back out to ~+30 days) and advanced
    // last_used_at — this is what makes the 30-day expiry truly sliding.
    expect(after.expiresAt > before.expiresAt).toBe(true);
    expect(after.lastUsedAt > before.lastUsedAt).toBe(true);
  });

  it("does NOT re-write a session used within the last hour (throttle)", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Katherine Johnson"));
    const { token } = createSession(id);
    const tokenHash = sha256hex(token);
    // Used 10 minutes ago (<1h), expiry parked at a known +10 days.
    ageSession(tokenHash, "-1 hours", "+10 days", "-10 minutes");
    const before = sessionRow(tokenHash)!;

    expect(resolveSessionToken(token)).not.toBeNull();

    const after = sessionRow(tokenHash)!;
    // The throttled WHERE (>1h stale) didn't match, so nothing was written.
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
  });

  it("refuses a session past the absolute ceiling EVEN when it kept sliding (issue #23)", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Rosalind Franklin"));
    const { token } = createSession(id);
    const tokenHash = sha256hex(token);
    // The attack the ceiling defends against: a session created 91 days ago whose
    // expires_at has been slid to the future on every use. Sliding never touches
    // created_at, so the created_at ceiling holds regardless of expiry.
    ageSession(tokenHash, "-91 days", "+30 days", "-1 minutes");

    expect(resolveSessionToken(token)).toBeNull();
    // The lookup simply doesn't match — it does not delete the row (the purge does).
    expect(sessionRow(tokenHash)).toBeDefined();
  });

  it("still resolves a long-lived session just INSIDE the ceiling", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Marie Curie"));
    const { token } = createSession(id);
    // 89 days old (< 90), fresh expiry — proves it's the ceiling, not expiry, that
    // kills the 91-day case above.
    ageSession(sha256hex(token), "-89 days", "+30 days", "-1 minutes");
    expect(resolveSessionToken(token)).not.toBeNull();
  });

  it("purgeExpiredSessions sweeps sliding-expired AND over-ceiling rows, keeps live ones", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Hedy Lamarr"));

    const live = createSession(id);
    const expired = createSession(id);
    const overCeiling = createSession(id);
    ageSession(sha256hex(expired.token), "-2 days", "-1 days", "-2 days"); // expires_at in the past
    ageSession(
      sha256hex(overCeiling.token),
      "-91 days",
      "+30 days",
      "-1 minutes"
    ); // fresh expiry, over ceiling

    expect(countSessions(id)).toBe(3);
    purgeExpiredSessions();

    expect(sessionRow(sha256hex(live.token))).toBeDefined();
    expect(sessionRow(sha256hex(expired.token))).toBeUndefined();
    expect(sessionRow(sha256hex(overCeiling.token))).toBeUndefined();
    expect(countSessions(id)).toBe(1);
  });
});

describe("access scoping", () => {
  it("a member sees only granted profiles; an admin sees them all", () => {
    const member = mkLogin("member");
    const admin = mkLogin("admin");
    const a = mkProfile("Profile A");
    const b = mkProfile("Profile B");
    grant(member.id, a); // member granted A only

    const memberSees = accessibleProfilesForLogin(member.id).map((p) => p.id);
    expect(memberSees).toEqual([a]);
    expect(memberSees).not.toContain(b);

    const adminSees = accessibleProfilesForLogin(admin.id).map((p) => p.id);
    expect(adminSees).toContain(a);
    expect(adminSees).toContain(b); // admin bypasses grants
  });

  it("switchActiveProfile refuses a target the member is NOT granted", () => {
    const member = mkLogin("member");
    const a = mkProfile("Granted");
    const b = mkProfile("Ungranted");
    grant(member.id, a);
    const { token } = createSession(member.id); // active = A (first accessible)
    const session = resolveSessionToken(token)!;

    const switched = switchActiveProfile(session, token, b);
    expect(switched).toBe(false);
    // The active profile is unchanged and no audit row was written.
    expect(sessionRow(sha256hex(token))!.activeProfileId).toBe(a);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = ?")
          .get(AUDIT_ACTIONS.profileSwitch) as { n: number }
      ).n
    ).toBe(0);
  });

  it("switchActiveProfile honors a granted target and audits the switch", () => {
    const member = mkLogin("member");
    const a = mkProfile("Home");
    const b = mkProfile("Other");
    grant(member.id, a);
    grant(member.id, b);
    const { token } = createSession(member.id);
    const session = resolveSessionToken(token)!;

    expect(switchActiveProfile(session, token, b)).toBe(true);
    expect(sessionRow(sha256hex(token))!.activeProfileId).toBe(b);
    const audit = db
      .prepare(
        "SELECT login_id, active_profile_id, target FROM audit_events WHERE action = ?"
      )
      .get(AUDIT_ACTIONS.profileSwitch) as {
      login_id: number;
      active_profile_id: number;
      target: string;
    };
    expect(audit.login_id).toBe(member.id);
    expect(audit.active_profile_id).toBe(b);
    expect(audit.target).toBe(String(b));
  });

  it("an admin can switch to ANY profile (grant bypass)", () => {
    const admin = mkLogin("admin");
    const a = mkProfile("A");
    const b = mkProfile("B");
    const { token } = createSession(admin.id); // admin's first accessible profile
    const session = resolveSessionToken(token)!;
    expect(switchActiveProfile(session, token, a)).toBe(true);
    expect(switchActiveProfile(session, token, b)).toBe(true);
    expect(sessionRow(sha256hex(token))!.activeProfileId).toBe(b);
  });

  it("a revoked grant takes effect on the NEXT resolution (re-derives active profile)", () => {
    const member = mkLogin("member");
    const a = mkProfile("Keeps");
    const b = mkProfile("Revoked");
    grant(member.id, a);
    grant(member.id, b);
    const { token } = createSession(member.id);
    const session = resolveSessionToken(token)!;
    // Sit the member on B.
    expect(switchActiveProfile(session, token, b)).toBe(true);
    expect(resolveSessionToken(token)!.profile.id).toBe(b);

    // Admin revokes the grant to B.
    db.prepare(
      "DELETE FROM login_profiles WHERE login_id = ? AND profile_id = ?"
    ).run(member.id, b);

    // Next resolution snaps to the first still-accessible profile (A) and persists it.
    const after = resolveSessionToken(token)!;
    expect(after.profile.id).toBe(a);
    expect(sessionRow(sha256hex(token))!.activeProfileId).toBe(a);
  });

  it("losing the LAST grant makes the session unresolvable", () => {
    const member = mkLogin("member");
    const a = mkProfile("Only");
    grant(member.id, a);
    const { token } = createSession(member.id);
    expect(resolveSessionToken(token)).not.toBeNull();

    db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(member.id);
    expect(resolveSessionToken(token)).toBeNull();
  });

  it("accessForProfile: read grant reads 'read', everything else reads 'write'", () => {
    const member = mkLogin("member");
    const admin = mkLogin("admin");
    const readP = mkProfile("Read-only");
    const writeP = mkProfile("Writable");
    const ungrantedP = mkProfile("No grant");
    grant(member.id, readP, "read");
    grant(member.id, writeP, "write");

    expect(accessForProfile(member.id, "member", readP)).toBe("read");
    expect(accessForProfile(member.id, "member", writeP)).toBe("write");
    // Missing grant defaults to the permissive legacy 'write' (never silently locks out).
    expect(accessForProfile(member.id, "member", ungrantedP)).toBe("write");
    // Admins are implicit all-write regardless of any row.
    expect(accessForProfile(admin.id, "admin", readP)).toBe("write");
  });

  it("canAccessProfile mirrors the accessible set", () => {
    const member = mkLogin("member");
    const a = mkProfile("Reachable");
    const b = mkProfile("Unreachable");
    grant(member.id, a);
    const { token } = createSession(member.id);
    const session = resolveSessionToken(token)!;
    expect(canAccessProfile(session, a)).toBe(true);
    expect(canAccessProfile(session, b)).toBe(false);
  });
});

describe("teardown", () => {
  it("destroyLoginSessions() kills every session row for the login", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Whoever"));
    createSession(id);
    createSession(id);
    createSession(id);
    expect(countSessions(id)).toBe(3);

    destroyLoginSessions(id);
    expect(countSessions(id)).toBe(0);
  });

  it("destroyLoginSessions(keepTokenHash) keeps EXACTLY the current session (change-own-password)", () => {
    const { id } = mkLogin();
    grant(id, mkProfile("Whoever"));
    const keep = createSession(id);
    createSession(id);
    createSession(id);
    expect(countSessions(id)).toBe(3);

    // This is the core destroyOtherSessionsForCurrent() delegates to after reading
    // the caller's cookie.
    destroyLoginSessions(id, sha256hex(keep.token));

    expect(countSessions(id)).toBe(1);
    expect(sessionRow(sha256hex(keep.token))).toBeDefined();
  });

  it("revokeSession is scoped to the owning login (can't revoke another login's session)", () => {
    const alice = mkLogin();
    const bob = mkLogin();
    grant(alice.id, mkProfile("Alice P"));
    grant(bob.id, mkProfile("Bob P"));
    const aliceSession = createSession(alice.id);
    const bobSession = createSession(bob.id);

    // Alice tries to revoke Bob's session by hash — scoped to login_id, so no-op.
    revokeSession(alice.id, sha256hex(bobSession.token));
    expect(sessionRow(sha256hex(bobSession.token))).toBeDefined();

    // Bob revokes his own — gone; Alice's untouched.
    revokeSession(bob.id, sha256hex(bobSession.token));
    expect(sessionRow(sha256hex(bobSession.token))).toBeUndefined();
    expect(sessionRow(sha256hex(aliceSession.token))).toBeDefined();
  });
});

describe("two-factor: TOTP enrollment + login", () => {
  it("enrolls with enabled=0, then activation flips it on within the window", () => {
    const { id, username } = mkLogin();
    const { secret, otpauthUrl } = beginTotpEnrollment(id, username);
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(otpauthUrl).toContain("otpauth://totp/");
    // Pending secret is not yet enforced.
    expect(getLoginTotpState(id).enabled).toBe(false);
    expect(isTotpEnabled(id)).toBe(false);

    const t0 = 1_700_000_000_000;
    const code = totp(secret, { timeMs: t0 })!;
    expect(activateTotp(id, code, t0)).toBe(true);
    expect(isTotpEnabled(id)).toBe(true);
    // The used step is recorded for the replay guard.
    expect(getLoginTotpState(id).lastStep).not.toBeNull();
  });

  it("activation fails for a wrong / stale code", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    const t0 = 1_700_000_000_000;
    // A code from 5 steps ago is outside the ±1 window.
    const stale = totp(secret, { timeMs: t0 - 5 * STEP_MS })!;
    expect(activateTotp(id, stale, t0)).toBe(false);
    expect(isTotpEnabled(id)).toBe(false);
  });

  it("accepts a fresh TOTP within the window at login, and refuses replay of a used step", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    const t0 = 1_700_000_000_000;
    activateTotp(id, totp(secret, { timeMs: t0 })!, t0); // lastStep = step(t0)

    // One step later: a NEW code at a step above lastStep is accepted.
    const t1 = t0 + STEP_MS;
    const res = verifyLoginSecondFactor(id, totp(secret, { timeMs: t1 })!, t1);
    expect(res).toEqual({ ok: true, viaRecovery: false });

    // Replaying the ORIGINAL activation code (its step is now <= lastStep) is
    // refused by the monotonic replay guard, even though it's within the window.
    const replay = verifyLoginSecondFactor(
      id,
      totp(secret, { timeMs: t0 })!,
      t0
    );
    expect(replay.ok).toBe(false);
  });

  it("rejects a TOTP outside the clock-skew window at login", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    const t0 = 1_700_000_000_000;
    activateTotp(id, totp(secret, { timeMs: t0 })!, t0);

    const later = t0 + 10 * STEP_MS;
    // Submit a code minted 5 steps before `later` — well outside ±1 step.
    const offWindow = totp(secret, { timeMs: later - 5 * STEP_MS })!;
    expect(verifyLoginSecondFactor(id, offWindow, later).ok).toBe(false);
  });

  it("verifyLoginSecondFactor is inert until 2FA is actually enabled", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username); // pending, enabled=0
    const t0 = 1_700_000_000_000;
    // A structurally valid code, but 2FA isn't enforced yet → refused.
    expect(
      verifyLoginSecondFactor(id, totp(secret, { timeMs: t0 })!, t0)
    ).toEqual({ ok: false, viaRecovery: false });
  });
});

describe("two-factor: recovery codes", () => {
  it("a recovery code is single-use (second use refused)", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    activateTotp(
      id,
      totp(secret, { timeMs: 1_700_000_000_000 })!,
      1_700_000_000_000
    );

    const codes = regenerateRecoveryCodes(id);
    expect(codes).toHaveLength(8);
    expect(countUnusedRecoveryCodes(id)).toBe(8);

    expect(consumeRecoveryCode(id, codes[0])).toBe(true);
    expect(consumeRecoveryCode(id, codes[0])).toBe(false); // already spent
    expect(countUnusedRecoveryCodes(id)).toBe(7);
  });

  it("verifyLoginSecondFactor redeems a recovery code once, flagging viaRecovery", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    activateTotp(
      id,
      totp(secret, { timeMs: 1_700_000_000_000 })!,
      1_700_000_000_000
    );
    const codes = regenerateRecoveryCodes(id);

    const first = verifyLoginSecondFactor(id, codes[1], 1_700_000_000_000);
    expect(first).toEqual({ ok: true, viaRecovery: true });
    // Reusing it: not a valid TOTP and no longer an unused recovery code.
    const second = verifyLoginSecondFactor(id, codes[1], 1_700_000_000_000);
    expect(second.ok).toBe(false);
  });

  it("regenerating replaces the whole set (old codes stop working)", () => {
    const { id } = mkLogin();
    const first = regenerateRecoveryCodes(id);
    const second = regenerateRecoveryCodes(id);
    expect(countUnusedRecoveryCodes(id)).toBe(8);
    // An old code no longer matches any stored hash.
    expect(consumeRecoveryCode(id, first[0])).toBe(false);
    expect(consumeRecoveryCode(id, second[0])).toBe(true);
  });

  it("disableTotp clears the secret, the enabled flag, and every recovery code", () => {
    const { id, username } = mkLogin();
    const { secret } = beginTotpEnrollment(id, username);
    activateTotp(
      id,
      totp(secret, { timeMs: 1_700_000_000_000 })!,
      1_700_000_000_000
    );
    regenerateRecoveryCodes(id);
    expect(countUnusedRecoveryCodes(id)).toBe(8);

    disableTotp(id);
    const state = getLoginTotpState(id);
    expect(state.enabled).toBe(false);
    expect(state.secret).toBeNull();
    expect(state.lastStep).toBeNull();
    expect(countUnusedRecoveryCodes(id)).toBe(0);
  });
});

describe("two-factor: login challenges", () => {
  it("creates, resolves, and consumes a second-factor challenge", () => {
    const { id, username } = mkLogin();
    const { token, maxAgeSec } = createTotpChallenge(
      id,
      username,
      "/dashboard"
    );
    expect(maxAgeSec).toBe(5 * 60);

    const chal = getTotpChallenge(token);
    expect(chal).toEqual({ loginId: id, username, nextPath: "/dashboard" });

    deleteTotpChallenge(token);
    expect(getTotpChallenge(token)).toBeNull();
  });

  it("does not resolve an expired challenge, and purge sweeps it", () => {
    const { id, username } = mkLogin();
    const { token } = createTotpChallenge(id, username, null);
    // Force it expired.
    db.prepare(
      "UPDATE login_totp_challenges SET expires_at = datetime('now','-1 minutes') WHERE token_hash = ?"
    ).run(sha256hex(token));
    expect(getTotpChallenge(token)).toBeNull();

    const live = createTotpChallenge(id, username, null);
    purgeExpiredTotpChallenges();
    // The expired row is gone; the live one survives.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM login_totp_challenges WHERE login_id = ?"
          )
          .get(id) as { n: number }
      ).n
    ).toBe(1);
    expect(getTotpChallenge(live.token)).not.toBeNull();
  });
});

describe("two-factor: ALLOS_DISABLE_2FA bypass", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches usernames case-insensitively across a comma+whitespace list", () => {
    vi.stubEnv("ALLOS_DISABLE_2FA", "  Admin , recovery-user ");
    expect(is2faBypassed("admin")).toBe(true);
    expect(is2faBypassed("ADMIN")).toBe(true);
    expect(is2faBypassed("recovery-user")).toBe(true);
    expect(is2faBypassed("someoneelse")).toBe(false);
  });

  it("is off when the env var is unset or empty", () => {
    vi.stubEnv("ALLOS_DISABLE_2FA", "");
    expect(is2faBypassed("admin")).toBe(false);
    vi.unstubAllEnvs();
    expect(is2faBypassed("admin")).toBe(false);
  });

  it("the bypass path writes its audit event; the non-bypassed path does not", () => {
    // The bypass DECISION is is2faBypassed() (this module's job); the audit WRITE
    // lives in the login action (app/(auth)/login/actions.ts), gated by
    // `isTotpEnabled(id) && is2faBypassed(username)`. This pins that composed
    // contract at the DB tier: when the gate is true the login.2fa-bypass audit
    // row is recorded; when it's false (username not listed) it is not.
    const bypassed = mkLogin();
    const challenged = mkLogin();
    const t0 = 1_700_000_000_000;
    for (const l of [bypassed, challenged]) {
      const { secret } = beginTotpEnrollment(l.id, l.username);
      activateTotp(l.id, totp(secret, { timeMs: t0 })!, t0);
    }
    vi.stubEnv("ALLOS_DISABLE_2FA", bypassed.username);

    for (const l of [bypassed, challenged]) {
      // Faithful reproduction of the login action's gate + side effect.
      if (isTotpEnabled(l.id) && is2faBypassed(l.username)) {
        recordAudit({
          loginId: l.id,
          action: AUDIT_ACTIONS.twofaBypass,
          detail: l.username,
        });
      }
    }

    const bypassRows = db
      .prepare("SELECT login_id FROM audit_events WHERE action = ?")
      .all(AUDIT_ACTIONS.twofaBypass) as { login_id: number }[];
    expect(bypassRows.map((r) => r.login_id)).toEqual([bypassed.id]);
  });
});

describe("instance-wide guard rails", () => {
  it("adminLoginCount counts admin logins and increments as one is added", () => {
    const before = adminLoginCount();
    mkLogin("member"); // does not change the admin count
    expect(adminLoginCount()).toBe(before);
    mkLogin("admin");
    expect(adminLoginCount()).toBe(before + 1);
  });
});
