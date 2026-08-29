import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3053 — the server has to be able to say REVOKED rather than merely
// unauthorized, and after the DELETE there is nothing left to say it with.
//
// Every one of the deliberate session-ending paths runs `DELETE FROM sessions`, and so
// does the expiry purge. A device that comes back afterwards presents a cookie whose row
// is simply absent, and absence cannot distinguish "an admin signed this phone out on
// suspicion of compromise" from "you were away for a month" — which is the whole fork
// #3053 records, and why #2994's ruling that a bare 401 must NOT wipe reads could not
// simply be relaxed.
//
// So a revocation leaves a TOMBSTONE and an expiry does not. The row is the token hash
// and nothing else that could identify anyone: no login id, no username, no user agent,
// no profile. A hash is already what `sessions` stores, it cannot be reversed into the
// cookie, and the only question ever asked of this table is "was this exact token
// deliberately ended" — which needs no other column to answer.
//
// RETENTION is bounded by the session lifetime it describes: a token past
// SESSION_ABSOLUTE_MAX_MODIFIER (90 days from creation) can never resolve to a session
// again, so a tombstone older than that can never change an answer. lib/auth's
// purgeExpiredSessions sweeps them on the same tick it sweeps dead sessions.
export const migration: Migration = {
  name: "20260829-revoked-session-tombstones",
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revoked_sessions (
        token_hash TEXT PRIMARY KEY,
        revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_revoked_sessions_at
        ON revoked_sessions(revoked_at);
    `);
  },
};
