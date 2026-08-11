// SERVER-ACTION TIER — the grantless sign-in outcome (issue #1434).
//
// A member login created with zero profile grants used to authenticate, mint a
// session, redirect — and then bounce back to an EMPTY sign-in form on every request
// (resolveSessionToken resolves a login with no accessible profile to null), with no
// error, no explanation, and a growing pile of unusable "active sessions". The
// sign-in action now refuses that login honestly and mints NOTHING.
//
// Like password-reset.actions.test.ts this runs before any session exists, so the
// shared setup's @/lib/auth mock is the wrong shape: restore the real module (the
// refusal is exactly the real accessibleProfiles decision) and mock next/headers +
// next/navigation, which have no request scope here.

import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9" }),
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string) => {
      cookiesSet.push({ name, value });
    },
    delete: () => {},
  }),
}));
// redirect() throws NEXT_REDIRECT in prod; here it throws a recognizable marker so a
// test can tell "signed in and left" from "refused with a message".
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const cookiesSet: { name: string; value: string }[] = [];

import { db } from "@/lib/db";
import { login } from "@/app/(auth)/login/actions";
import { NO_PROFILE_ACCESS } from "@/lib/login-security";
import { resolveSessionToken, createSession, SESSION_COOKIE } from "@/lib/auth";
import { hashPasswordSync } from "@/lib/password";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { ACTION_TEST_PASSWORD } from "./password-fixture";

function mkLogin(role: "admin" | "member" = "member"): {
  id: number;
  username: string;
} {
  const username = `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, ?)"
      )
      .run(username, hashPasswordSync(ACTION_TEST_PASSWORD), role)
      .lastInsertRowid
  );
  return { id, username };
}

function mkProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(loginId, profileId);
}

function sessionCount(loginId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE login_id = ?")
      .get(loginId) as { c: number }
  ).c;
}

function signIn(username: string, password = ACTION_TEST_PASSWORD) {
  const fd = new FormData();
  fd.set("username", username);
  fd.set("password", password);
  return login({}, fd);
}

beforeEach(() => {
  cookiesSet.length = 0;
  // The lockout throttle counts across the whole file's fixtures; start clean.
  db.prepare("DELETE FROM login_attempts").run();
});

describe("sign-in for a login with no profile access (#1434)", () => {
  it("refuses honestly instead of silently bouncing", async () => {
    const { username } = mkLogin();
    const state = await signIn(username);
    expect(state.error).toBe(NO_PROFILE_ACCESS);
    expect(state.needsTotp).toBeUndefined();
  });

  it("mints NO session and sets no cookie", async () => {
    const { id, username } = mkLogin();
    await signIn(username);
    await signIn(username);
    // Two attempts, zero sessions — the old behavior showed "2 active sessions"
    // on a login that could never reach a page.
    expect(sessionCount(id)).toBe(0);
    expect(cookiesSet).toEqual([]);
  });

  it("audits the refusal so the admin has a signal", async () => {
    const { id, username } = mkLogin();
    await signIn(username);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE login_id = ? AND action = ?"
      )
      .get(id, AUDIT_ACTIONS.loginNoAccess) as { c: number };
    expect(row.c).toBe(1);
  });

  it("keeps the credential outcome opaque for a WRONG password", async () => {
    // The honest message is only ever reached after the credentials verified, so a
    // prober with the wrong password still learns nothing about the login's grants.
    const { username } = mkLogin();
    const state = await signIn(username, "not-the-password");
    expect(state.error).toBe("Incorrect username or password.");
  });

  it("signs a granted member in normally", async () => {
    const { id, username } = mkLogin();
    grant(id, mkProfile("Grantless Test Home"));
    await expect(signIn(username)).rejects.toThrow(/^REDIRECT:/);
    expect(sessionCount(id)).toBe(1);
    expect(cookiesSet.map((c) => c.name)).toContain(SESSION_COOKIE);
  });
});

describe("a session that OUTLIVES its grants (#1434)", () => {
  it("is torn down on resolve rather than left as a zombie row", () => {
    const { id, username } = mkLogin();
    const profileId = mkProfile(`Revoked Home ${username}`);
    grant(id, profileId);
    const { token } = createSession(id, null);
    expect(resolveSessionToken(token)).not.toBeNull();

    // The admin revokes the member's last grant.
    db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(id);

    expect(resolveSessionToken(token)).toBeNull();
    // …and the row is gone, so Family stops counting it as an active session and a
    // stale cookie can't keep resolving to nothing forever.
    expect(sessionCount(id)).toBe(0);
  });
});
