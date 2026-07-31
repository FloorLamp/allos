// DB INTEGRATION TIER — API tokens (#1734): mint → verify → revoke, and the
// login-tie that makes the whole design safe.
//
// What this pins:
//   • a minted token verifies, and the DB stores NO plaintext (scrypt hash only)
//   • a revoked token stops verifying immediately, and the revoke is a
//     compare-and-swap (a second revoke reports false rather than re-stamping)
//   • a scope mismatch is refused, distinctly from a bad credential
//   • last_used_at is stamped on a SUCCESSFUL authentication and not before
//   • deleting a login takes its tokens with it
//   • the helper returns the login's CURRENT role/identity — authorization is
//     derived per request, never frozen onto the token row
//
// Every token value in this file is produced at runtime by createApiToken; nothing
// secret-shaped is written as a literal.

import { describe, it, expect, beforeEach } from "vitest";
import { db, writeTx } from "@/lib/db";
import {
  authenticateApiToken,
  countApiTokensForLogin,
  createApiToken,
  deleteApiTokensForLogin,
  listAllApiTokens,
  listApiTokensForLogin,
  revokeApiToken,
} from "@/lib/api-tokens";
import { formatApiToken, parseApiToken } from "@/lib/api-token-format";

let memberId: number;
let adminId: number;

function makeLogin(username: string, role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

// A bearer request, the way a route sees one.
function bearer(token: string): Request {
  return new Request("https://example.test/api/documents", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  db.exec("DELETE FROM api_tokens");
  db.exec("DELETE FROM logins");
  memberId = makeLogin("token-member", "member");
  adminId = makeLogin("token-admin", "admin");
});

describe("mint and verify", () => {
  it("a freshly minted token authenticates as its login", async () => {
    const { token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    const auth = await authenticateApiToken(bearer(token), "upload:documents");
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.login.id).toBe(memberId);
    expect(auth.login.username).toBe("token-member");
    expect(auth.login.role).toBe("member");
    expect(auth.scope).toBe("upload:documents");
  });

  it("stores only a scrypt hash — no plaintext anywhere in the row", async () => {
    const { id, token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    const parsed = parseApiToken(token);
    expect(parsed).not.toBeNull();
    const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    expect(row).toBeTruthy();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(parsed!.secret);
    expect(dump).not.toContain(token);
    expect(String(row!.secret_hash)).toMatch(/^scrypt\$/);
  });

  it("two mints never collide and each only opens its own row", async () => {
    const a = await createApiToken(memberId, "one", "upload:documents");
    const b = await createApiToken(memberId, "two", "upload:documents");
    expect(a.token).not.toBe(b.token);
    // A's secret presented against B's id must fail: the id half is public, so the
    // security rests entirely on the per-row hash.
    const crossed = formatApiToken(b.id, parseApiToken(a.token)!.secret);
    const auth = await authenticateApiToken(
      bearer(crossed),
      "upload:documents"
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.status).toBe(401);
  });

  it("refuses a malformed, unknown, or wrong-secret credential with the same 401", async () => {
    const { id } = await createApiToken(memberId, "laptop", "upload:documents");
    for (const wire of [
      "garbage",
      "1",
      `${id}.wrong-secret-here-00`,
      `${id + 9999}.some-secret-value-00`,
    ]) {
      const auth = await authenticateApiToken(bearer(wire), "upload:documents");
      expect(auth.ok, wire).toBe(false);
      if (auth.ok) continue;
      expect(auth.status).toBe(401);
      expect(auth.error).toBe("invalid or missing API token");
    }
  });

  it("refuses a request with no Authorization header at all", async () => {
    const req = new Request("https://example.test/api/documents", {
      method: "POST",
    });
    const auth = await authenticateApiToken(req, "upload:documents");
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.status).toBe(401);
  });
});

describe("scope", () => {
  it("refuses a capability the token does not carry, with a distinct 403", async () => {
    const { token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    // Demand a capability this token lacks. `as never` because the v1 vocabulary has
    // exactly one member — the point is that the CHECK is on the demanded string, so
    // this stays honest as scopes are added.
    const auth = await authenticateApiToken(
      bearer(token),
      "read:documents" as never
    );
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.status).toBe(403);
  });

  it("does not stamp last_used_at when the scope check refuses", async () => {
    const { id, token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    await authenticateApiToken(bearer(token), "read:documents" as never);
    const row = db
      .prepare("SELECT last_used_at AS lastUsed FROM api_tokens WHERE id = ?")
      .get(id) as { lastUsed: string | null };
    expect(row.lastUsed).toBeNull();
  });
});

describe("last_used_at", () => {
  it("is null until the token is actually used, then stamped", async () => {
    const { id, token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    expect(listApiTokensForLogin(memberId)[0].lastUsedAt).toBeNull();

    const auth = await authenticateApiToken(bearer(token), "upload:documents");
    expect(auth.ok).toBe(true);

    const row = db
      .prepare("SELECT last_used_at AS lastUsed FROM api_tokens WHERE id = ?")
      .get(id) as { lastUsed: string | null };
    expect(row.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(listApiTokensForLogin(memberId)[0].lastUsedAt).toBe(row.lastUsed);
  });

  it("is not stamped for a bad secret against a real id", async () => {
    const { id } = await createApiToken(memberId, "laptop", "upload:documents");
    await authenticateApiToken(
      bearer(`${id}.wrong-secret-here-00`),
      "upload:documents"
    );
    const row = db
      .prepare("SELECT last_used_at AS lastUsed FROM api_tokens WHERE id = ?")
      .get(id) as { lastUsed: string | null };
    expect(row.lastUsed).toBeNull();
  });
});

describe("revocation", () => {
  it("a revoked token stops authenticating immediately", async () => {
    const { id, token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    expect(
      (await authenticateApiToken(bearer(token), "upload:documents")).ok
    ).toBe(true);

    expect(revokeApiToken(id, memberId, "member")).toBe(true);

    const auth = await authenticateApiToken(bearer(token), "upload:documents");
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    // Same generic 401 as an unknown id — a revoked token is not an oracle.
    expect(auth.status).toBe(401);
    expect(auth.error).toBe("invalid or missing API token");
  });

  it("is a compare-and-swap: the second revoke reports false", async () => {
    const { id } = await createApiToken(memberId, "laptop", "upload:documents");
    expect(revokeApiToken(id, memberId, "member")).toBe(true);
    expect(revokeApiToken(id, memberId, "member")).toBe(false);
  });

  it("drops the token from the listing but keeps the id spent", async () => {
    const { id } = await createApiToken(memberId, "laptop", "upload:documents");
    expect(listApiTokensForLogin(memberId)).toHaveLength(1);
    revokeApiToken(id, memberId, "member");
    expect(listApiTokensForLogin(memberId)).toHaveLength(0);
    expect(countApiTokensForLogin(memberId)).toBe(0);
    // The tombstone row survives, so the id can never be handed out again.
    const still = db
      .prepare("SELECT revoked_at AS revokedAt FROM api_tokens WHERE id = ?")
      .get(id) as { revokedAt: string | null } | undefined;
    expect(still?.revokedAt).toBeTruthy();
  });

  it("a member cannot revoke another login's token", async () => {
    const otherId = makeLogin("token-other", "member");
    const { id, token } = await createApiToken(
      otherId,
      "theirs",
      "upload:documents"
    );
    expect(revokeApiToken(id, memberId, "member")).toBe(false);
    // …and the victim's token still works.
    expect(
      (await authenticateApiToken(bearer(token), "upload:documents")).ok
    ).toBe(true);
  });

  it("an admin may revoke any login's token", async () => {
    const { id } = await createApiToken(memberId, "theirs", "upload:documents");
    expect(revokeApiToken(id, adminId, "admin")).toBe(true);
  });
});

describe("listing", () => {
  it("a member sees only their own tokens; the admin view sees all", async () => {
    await createApiToken(memberId, "member token", "upload:documents");
    await createApiToken(adminId, "admin token", "upload:documents");

    const mine = listApiTokensForLogin(memberId);
    expect(mine.map((t) => t.name)).toEqual(["member token"]);
    expect(mine[0].username).toBe("token-member");

    const all = listAllApiTokens();
    expect(all.map((t) => t.name).sort()).toEqual([
      "admin token",
      "member token",
    ]);
  });

  it("never exposes secret material", async () => {
    const { token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    const secret = parseApiToken(token)!.secret;
    const dump = JSON.stringify(listAllApiTokens());
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("scrypt$");
    expect(dump).not.toContain("secret");
  });
});

describe("the login tie", () => {
  it("reflects the login's CURRENT role, not the role at mint time", async () => {
    const { token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    db.prepare("UPDATE logins SET role = 'admin' WHERE id = ?").run(memberId);
    const auth = await authenticateApiToken(bearer(token), "upload:documents");
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    // The route then feeds this role into accessForProfile / isDemoRestricted, so a
    // demotion or promotion takes effect on the very next request.
    expect(auth.login.role).toBe("admin");
  });

  it("deleting the login takes its tokens with it", async () => {
    const { token } = await createApiToken(
      memberId,
      "laptop",
      "upload:documents"
    );
    // The explicit sweep deleteLogin runs (the FK cascade would also fire, but the
    // teardown must hold with foreign_keys off).
    writeTx(() => {
      deleteApiTokensForLogin(memberId);
      db.prepare("DELETE FROM logins WHERE id = ?").run(memberId);
    });
    const auth = await authenticateApiToken(bearer(token), "upload:documents");
    expect(auth.ok).toBe(false);
    expect(countApiTokensForLogin(memberId)).toBe(0);
  });

  it("the FK cascade alone also clears them", async () => {
    const { id } = await createApiToken(memberId, "laptop", "upload:documents");
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM logins WHERE id = ?").run(memberId);
    const row = db.prepare("SELECT id FROM api_tokens WHERE id = ?").get(id);
    expect(row).toBeUndefined();
  });
});

describe("schema", () => {
  it("carries no profile_id — a token is login-tied, not profile-owned", () => {
    const cols = (
      db.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("profile_id");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "login_id",
        "name",
        "scope",
        "secret_hash",
        "created_at",
        "last_used_at",
        "revoked_at",
      ])
    );
  });

  it("refuses an unknown capability at the storage layer", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO api_tokens (login_id, name, scope, secret_hash) VALUES (?, 'x', 'read:everything', 'scrypt$2$1$1$00$00')"
        )
        .run(memberId)
    ).toThrow();
  });
});
