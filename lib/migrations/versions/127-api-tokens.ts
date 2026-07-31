import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 127 (issue #1734): `api_tokens` — login-tied, capability-scoped bearer
// credentials, the foundation for remote (non-cookie) API access.
//
// WHY IT HANGS OFF A LOGIN. Every authenticated surface in the app is cookie-session
// based, so nothing outside a browser can call the instance. The rejected alternative
// was a shared secret in the global `settings` table: that would bypass the access
// model entirely (one string, no owner, no grants, no revocation story). A token
// instead names a LOGIN, and authorization is DERIVED at request time from that
// login's current role + `login_profiles` grants — never frozen onto the token row.
// Revoking a member's access to a profile therefore instantly revokes it from every
// token they hold, and deleting the login takes its tokens with it (ON DELETE
// CASCADE, plus an explicit DELETE in deleteLogin for the foreign_keys-off case, the
// login_auth_tokens posture from migration 064).
//
// NOT PROFILE-OWNED. There is deliberately no `profile_id` column: a login's identity
// spans every profile it can reach, exactly like `logins`, `sessions`, and
// `login_auth_tokens`. So this table does NOT join lib/owned-tables.ts (that constant
// is the set of tables carrying `profile_id`, which deleteProfile clears and the
// profile-scoping leak test enforces `profile_id` on). The schema-derived agreement
// test in lib/__tests__/profile-scoping.test.ts computes the owned set from CREATE
// TABLE blocks that declare `profile_id`, so a column-less table is correctly outside
// it with no allowlist entry needed. Profile REACH for a token is resolved per request
// through the same accessForProfile/login_profiles machinery a session uses.
//
// COLUMNS:
//
//   id — INTEGER PRIMARY KEY AUTOINCREMENT. This is the PUBLIC half of the wire
//     format `<id>.<secret>`: the request path looks the row up BY ID and then
//     verifies the presented secret against `secret_hash`. No table scan, and no
//     timing surface across other people's tokens. AUTOINCREMENT (not a bare rowid)
//     so an id is never recycled after a delete — a wire id always means at most one
//     token that ever existed.
//
//   secret_hash — the scrypt hash of the secret half, in lib/password.ts's
//     self-describing `scrypt$N$r$p$salt$hash` form, written and verified through that
//     module's ASYNC helpers (request paths must never block Node's thread for
//     ~100ms). The plaintext is returned exactly ONCE at mint and never stored — the
//     Health Connect token posture (#1209) and the session-token/share-link posture
//     before it. A DB leak yields nothing replayable.
//
//   scope — the capability this token carries, CHECK-constrained to the known set so
//     an unknown capability can never be persisted. v1 ships exactly one:
//     'upload:documents', write-only by design — a leaked upload token can ADD
//     documents and read nothing back. Read scopes are future work and deliberately
//     absent. Growing this enum needs a rebuild migration (CLAUDE.md), which is the
//     intended friction for adding a capability.
//
//   name — the human label shown in the management UI ("laptop CLI").
//
//   created_at / last_used_at / revoked_at — the lifecycle. There is NO expiry column:
//     v1 has revocation and last-used visibility only, and TTLs get added when a scope
//     justifies them. `revoked_at` is a TOMBSTONE, not a delete: the row stays so its
//     id is permanently spent and a revoked token can never be resurrected by a
//     re-mint landing on the same id. Revocation is a compare-and-swap
//     (`WHERE revoked_at IS NULL`), because an access-control transition must be
//     atomic rather than last-write-wins.
//
// Determinism (spec): reads only the DB catalog and its own constants.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS api_tokens (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       login_id     INTEGER NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
       name         TEXT NOT NULL,
       scope        TEXT NOT NULL CHECK(scope IN ('upload:documents')),
       secret_hash  TEXT NOT NULL,
       created_at   TEXT NOT NULL DEFAULT (datetime('now')),
       last_used_at TEXT,
       revoked_at   TEXT
     )`
  );
  // The management UI lists a login's own tokens; the admin view reads them all,
  // ordered by id. One index on the owning login covers the former.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_tokens_login ON api_tokens(login_id)"
  );
}

export const migration: Migration = {
  id: 127,
  name: "127-api-tokens",
  up,
};
