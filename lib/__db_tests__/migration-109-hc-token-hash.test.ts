// DB INTEGRATION TIER — migration 109 (#1209): the one-shot hash-in-place of
// existing raw-stored Health Connect ingest tokens. Applied to a hand-built
// minimal integration_connections table (the migration-045/077 pattern): a
// health-connect row carrying a plaintext `token` is rewritten to `tokenHash` =
// sha256(token) with the lifecycle stamps preserved; a row already hashed, a
// tokenless row, and a non-health-connect row all stay byte-identical; and a replay
// is a pure no-op (no plaintext tokens remain).

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { up } from "@/lib/migrations/versions/109-health-connect-token-hash";

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

function seed(): { db: Database.Database } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE integration_connections (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       profile_id INTEGER NOT NULL,
       provider TEXT NOT NULL,
       status TEXT,
       config TEXT,
       updated_at TEXT
     );`
  );
  const ins = db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, ?, 'connected', ?)`
  );
  // (a) legacy raw-stored HC token + lifecycle stamps.
  ins.run(
    1,
    "health-connect",
    JSON.stringify({
      token: "e2e-hc-token-test-value-1",
      tokenCreatedAt: "2025-01-01T00:00:00.000Z",
      tokenExpiresAt: "2026-01-01T00:00:00.000Z",
      tokenLastUsedAt: "2025-06-01T00:00:00.000Z",
    })
  );
  // (b) already-hashed HC row — must stay byte-identical.
  ins.run(
    2,
    "health-connect",
    JSON.stringify({ tokenHash: sha256("already"), tokenCreatedAt: "x" })
  );
  // (c) HC row with a null config — untouched.
  ins.run(3, "health-connect", null);
  // (d) a non-health-connect provider carrying a `token` — must NOT be hashed.
  ins.run(4, "oura", JSON.stringify({ token: "e2e-oura-token-test-value-1" }));
  return { db };
}

function config(
  db: Database.Database,
  profileId: number
): Record<string, unknown> {
  const r = db
    .prepare(
      "SELECT config FROM integration_connections WHERE profile_id = ? LIMIT 1"
    )
    .get(profileId) as { config: string | null };
  return r.config ? JSON.parse(r.config) : {};
}

describe("migration 109 — Health Connect token hash-in-place", () => {
  it("rewrites a raw token to its sha256 hash, preserving lifecycle stamps", () => {
    const { db } = seed();
    up(db);
    const cfg = config(db, 1);
    expect(cfg.token).toBeUndefined();
    expect(cfg.tokenHash).toBe(sha256("e2e-hc-token-test-value-1"));
    expect(cfg.tokenCreatedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(cfg.tokenExpiresAt).toBe("2026-01-01T00:00:00.000Z");
    expect(cfg.tokenLastUsedAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("leaves an already-hashed HC row, a null-config row, and a non-HC token untouched", () => {
    const { db } = seed();
    up(db);
    expect(config(db, 2).tokenHash).toBe(sha256("already"));
    expect(config(db, 2).token).toBeUndefined();
    const nullRow = db
      .prepare(
        "SELECT config FROM integration_connections WHERE profile_id = 3"
      )
      .get() as { config: string | null };
    expect(nullRow.config).toBeNull();
    // The non-HC provider keeps its plaintext (out of scope for #1209).
    expect(config(db, 4).token).toBe("e2e-oura-token-test-value-1");
  });

  it("is a pure no-op on replay (no plaintext HC tokens remain)", () => {
    const { db } = seed();
    up(db);
    const after = config(db, 1);
    up(db);
    expect(config(db, 1)).toEqual(after);
  });
});
