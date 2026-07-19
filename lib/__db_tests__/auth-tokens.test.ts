// DB INTEGRATION TIER — the login-lifecycle auth tokens (lib/auth-tokens.ts) +
// the migration 063 schema (logins.email unique-if-set, login_auth_tokens) against
// a real SQLite handle (issue #985). Covers the security-critical row behavior the
// pure tier structurally can't: hash-at-rest, consume-once, expiry, and the
// unique-if-set email constraint.

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  createAuthToken,
  consumeAuthToken,
  peekAuthToken,
  invalidateAuthTokensForLogin,
  findLoginIdByEmail,
} from "@/lib/auth-tokens";
import { hashAuthToken } from "@/lib/auth-token-crypto";

let loginId: number;

function mkLogin(username: string, email: string | null = null): number {
  const info = db
    .prepare(
      "INSERT INTO logins (username, password_hash, role, email) VALUES (?, 'x', 'member', ?)"
    )
    .run(username, email);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  db.prepare("DELETE FROM login_auth_tokens").run();
  // Fresh, uniquely-named login each test (integer ids never recycle).
  loginId = mkLogin(`u-${crypto.randomUUID()}`);
});

describe("login_auth_tokens rows (#985)", () => {
  it("stores only the token HASH, never the raw token", () => {
    const raw = createAuthToken(loginId, "reset");
    const row = db
      .prepare("SELECT token_hash FROM login_auth_tokens WHERE login_id = ?")
      .get(loginId) as { token_hash: string };
    expect(row.token_hash).toBe(hashAuthToken(raw));
    expect(row.token_hash).not.toBe(raw);
    // The raw token appears nowhere in the table.
    const all = db.prepare("SELECT * FROM login_auth_tokens").all();
    expect(JSON.stringify(all)).not.toContain(raw);
  });

  it("consumes a valid token once and returns the login + kind", () => {
    const raw = createAuthToken(loginId, "invite");
    const first = consumeAuthToken(raw);
    expect(first).toEqual({ loginId, kind: "invite" });
    // Second use is refused (single-use).
    expect(consumeAuthToken(raw)).toBeNull();
  });

  it("peek does not consume; consume after peek still works", () => {
    const raw = createAuthToken(loginId, "reset");
    expect(peekAuthToken(raw)).toEqual({ loginId, kind: "reset" });
    expect(peekAuthToken(raw)).toEqual({ loginId, kind: "reset" }); // still valid
    expect(consumeAuthToken(raw)).toEqual({ loginId, kind: "reset" });
    expect(peekAuthToken(raw)).toBeNull(); // now spent
  });

  it("rejects an expired token (consume + peek)", () => {
    const raw = createAuthToken(loginId, "reset");
    // Force the row's expiry into the past.
    db.prepare(
      "UPDATE login_auth_tokens SET expires_at = datetime('now','-1 hour') WHERE login_id = ?"
    ).run(loginId);
    expect(peekAuthToken(raw)).toBeNull();
    expect(consumeAuthToken(raw)).toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(consumeAuthToken("nope")).toBeNull();
    expect(peekAuthToken("")).toBeNull();
  });

  it("minting a new token of a kind retires the prior unconsumed one", () => {
    const first = createAuthToken(loginId, "invite");
    const second = createAuthToken(loginId, "invite");
    expect(consumeAuthToken(first)).toBeNull(); // superseded
    expect(consumeAuthToken(second)).toEqual({ loginId, kind: "invite" });
  });

  it("invalidateAuthTokensForLogin kills every outstanding token", () => {
    const a = createAuthToken(loginId, "invite");
    const b = createAuthToken(loginId, "reset");
    invalidateAuthTokensForLogin(loginId);
    expect(consumeAuthToken(a)).toBeNull();
    expect(consumeAuthToken(b)).toBeNull();
  });

  it("findLoginIdByEmail resolves NOCASE, or null", () => {
    const id = mkLogin(`e-${crypto.randomUUID()}`, "Person@Example.com");
    expect(findLoginIdByEmail("person@example.com")).toBe(id);
    expect(findLoginIdByEmail("PERSON@EXAMPLE.COM")).toBe(id);
    expect(findLoginIdByEmail("missing@example.com")).toBeNull();
    expect(findLoginIdByEmail("")).toBeNull();
  });
});

describe("logins.email migration constraint (#985)", () => {
  it("allows many NULL emails but rejects a duplicate set email (NOCASE)", () => {
    mkLogin(`n1-${crypto.randomUUID()}`, null);
    mkLogin(`n2-${crypto.randomUUID()}`, null); // two NULLs are fine
    mkLogin(`d1-${crypto.randomUUID()}`, "dup@example.com");
    expect(() =>
      mkLogin(`d2-${crypto.randomUUID()}`, "DUP@example.com")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("deleting a login cascades its tokens (FK ON DELETE CASCADE)", () => {
    const id = mkLogin(`c-${crypto.randomUUID()}`);
    createAuthToken(id, "reset");
    db.prepare("DELETE FROM logins WHERE id = ?").run(id);
    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM login_auth_tokens WHERE login_id = ?"
        )
        .get(id) as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
