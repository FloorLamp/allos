// SERVER-ACTION TIER — the PUBLIC login-lifecycle flows (issue #985):
// requestPasswordReset (enumeration-safe + rate-limited) and completeSetPassword
// (single-use token → set password, destroys the login's sessions, 2FA untouched).
//
// These run before any session exists, so the shared setup's @/lib/auth mock is the
// wrong shape (they need the REAL destroyLoginSessions); restore the real module for
// this file, and mock next/headers so clientIp() resolves without a request scope.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9" }),
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

import { db } from "@/lib/db";
import { requestPasswordReset } from "@/app/(auth)/forgot-password/actions";
import { completeSetPassword } from "@/app/(auth)/set-password/actions";
import { setSmtpConfig, setPublicUrl } from "@/lib/settings";
import { createAuthToken, peekAuthToken } from "@/lib/auth-tokens";
import { verifyPassword } from "@/lib/password";
import { RESET_REQUEST_MESSAGE } from "@/lib/auth-email";
import { RESET_PER_EMAIL_LIMIT } from "@/lib/auth-email-ratelimit";

const captureFile = path.join(
  os.tmpdir(),
  `allos-mail-reset-${process.pid}-${Date.now()}.jsonl`
);
const STRONG = "Zt7-mln-Qp9x!";

function captured(): string {
  return fs.readFileSync(captureFile, "utf8");
}

function mkLoginWithEmail(email: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role, email) VALUES (?, 'old-hash', 'member', ?)"
      )
      .run(`u-${crypto.randomUUID()}`, email).lastInsertRowid
  );
}

beforeEach(() => {
  fs.writeFileSync(captureFile, "");
  process.env.EMAIL_TEST_CAPTURE = captureFile;
  setSmtpConfig({
    host: "smtp.example.com",
    port: 587,
    user: "",
    from: "allos@example.com",
  });
  setPublicUrl("https://app.example.com");
});

afterAll(() => {
  try {
    fs.rmSync(captureFile, { force: true });
  } catch {
    // throwaway
  }
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("requestPasswordReset — enumeration-safe (#985)", () => {
  it("answers with the SAME generic message for a known and an unknown email", async () => {
    const known = `known-${crypto.randomUUID()}@example.com`;
    mkLoginWithEmail(known);

    const unknown = await requestPasswordReset(
      {},
      mkForm({ email: `nobody-${crypto.randomUUID()}@example.com` })
    );
    expect(unknown.message).toBe(RESET_REQUEST_MESSAGE);
    expect(captured()).not.toContain("/set-password?token=");

    const hit = await requestPasswordReset({}, mkForm({ email: known }));
    expect(hit.message).toBe(RESET_REQUEST_MESSAGE);
    // Only the KNOWN address gets a link emailed.
    expect(captured()).toContain(known);
    expect(captured()).toContain("/set-password?token=");
  });

  it("rate-limits sends per email (still generic-message throughout)", async () => {
    const email = `rl-${crypto.randomUUID()}@example.com`;
    mkLoginWithEmail(email);
    for (let i = 0; i < RESET_PER_EMAIL_LIMIT + 3; i++) {
      const r = await requestPasswordReset({}, mkForm({ email }));
      expect(r.message).toBe(RESET_REQUEST_MESSAGE);
    }
    const sends = captured()
      .split("\n")
      .filter((l) => l.includes("set-password")).length;
    expect(sends).toBe(RESET_PER_EMAIL_LIMIT);
  });
});

describe("completeSetPassword — set password, evict sessions, keep 2FA (#985)", () => {
  it("sets the password, destroys the login's sessions, and consumes the token", async () => {
    const email = `c-${crypto.randomUUID()}@example.com`;
    const loginId = mkLoginWithEmail(email);
    // Enrolled 2FA + two live sessions.
    db.prepare(
      "UPDATE logins SET totp_enabled = 1, totp_secret = 'SECRET' WHERE id = ?"
    ).run(loginId);
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO sessions (token_hash, login_id, active_profile_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, NULL, datetime('now'), datetime('now','+30 days'), datetime('now'))`
      ).run(crypto.randomUUID(), loginId);
    }
    const raw = createAuthToken(loginId, "reset");

    const res = await completeSetPassword(
      {},
      mkForm({ token: raw, password: STRONG })
    );
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        "SELECT password_hash, totp_enabled, totp_secret FROM logins WHERE id = ?"
      )
      .get(loginId) as {
      password_hash: string;
      totp_enabled: number;
      totp_secret: string | null;
    };
    expect(await verifyPassword(STRONG, row.password_hash)).toBe(true);
    // 2FA is untouched — a TOTP login still needs its code next sign-in.
    expect(row.totp_enabled).toBe(1);
    expect(row.totp_secret).toBe("SECRET");
    // All sessions destroyed.
    const sessions = (
      db
        .prepare("SELECT COUNT(*) AS c FROM sessions WHERE login_id = ?")
        .get(loginId) as { c: number }
    ).c;
    expect(sessions).toBe(0);
    // Token spent.
    expect(peekAuthToken(raw)).toBeNull();
  });

  it("rejects an invalid token with a generic message", async () => {
    const res = await completeSetPassword(
      {},
      mkForm({ token: "garbage", password: STRONG })
    );
    expect(res.ok).toBeUndefined();
    expect(res.error).toMatch(/invalid or has expired/i);
  });

  it("a weak password does NOT consume the token (retryable)", async () => {
    const loginId = mkLoginWithEmail(`w-${crypto.randomUUID()}@example.com`);
    const raw = createAuthToken(loginId, "reset");
    const res = await completeSetPassword(
      {},
      mkForm({ token: raw, password: "short" })
    );
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();
    // Still valid — the user can retry with a stronger password.
    expect(peekAuthToken(raw)).not.toBeNull();
  });
});

// Small FormData builder (the harness's fd is fine too, but this file doesn't import
// the harness — it drives PUBLIC actions, not admin ones).
function mkForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}
