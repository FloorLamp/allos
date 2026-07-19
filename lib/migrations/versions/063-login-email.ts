import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 063 (issue #985 — outbound email, phase 1b login lifecycle). Two
// additions, both login-scoped GLOBAL auth infrastructure (no `profile_id`, so
// NEITHER goes in lib/owned-tables.ts — same treatment as `logins`/`sessions`):
//
//   1. logins.email — an OPTIONAL address on a login, the target for invite +
//      self-service-reset mail. Unique-if-set COLLATE NOCASE so the reset lookup
//      resolves at most one login per address, surfaced with the same friendly-
//      constraint handling as logins.username. A partial UNIQUE INDEX (WHERE email
//      IS NOT NULL) enforces uniqueness only on set values, so the many logins
//      WITHOUT an email don't collide on NULL.
//
//   2. login_auth_tokens — single-use, hash-at-rest tokens backing the two flows
//      (kind 'invite' | 'reset'). Only the SHA-256 of the raw token is stored (the
//      session-token / share-link precedent), so a DB leak yields no usable link.
//      A token is spent by stamping consumed_at, and every token dies when its
//      login is deleted (ON DELETE CASCADE). expires_at is an absolute instant;
//      the consume path additionally checks it, so an expired-but-unconsumed token
//      is inert. Not profile-owned (a login's identity spans profiles), so it is a
//      global table like `sessions`.

export function up(db: Database.Database): void {
  // 1. Optional email on a login. Added as a plain nullable column, then the
  //    unique-if-set index. (A bare ADD COLUMN can't carry a partial UNIQUE, so
  //    the index is a separate statement.)
  const cols = db.prepare("PRAGMA table_info(logins)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "email")) {
    db.exec("ALTER TABLE logins ADD COLUMN email TEXT");
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_logins_email
       ON logins(email COLLATE NOCASE)
     WHERE email IS NOT NULL`
  );

  // 2. Single-use, hash-at-rest auth tokens.
  db.exec(
    `CREATE TABLE IF NOT EXISTS login_auth_tokens (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       login_id    INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL CHECK(kind IN ('invite','reset')),
       token_hash  TEXT NOT NULL UNIQUE,
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       expires_at  TEXT NOT NULL,
       consumed_at TEXT
     )`
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_login_auth_tokens_login ON login_auth_tokens(login_id)"
  );
}

export const migration: Migration = {
  id: 63,
  name: "063-login-email",
  up,
};
