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
// RETENTION IS A TRADE, and lib/auth's purgeExpiredSessions — which sweeps these on the
// same tick it sweeps dead sessions — carries the whole of it. In short: retiring a
// tombstone DOES change an answer, because `sessionDenial` is consulted only after
// resolution has already failed, so the row is the difference between "revoked" and
// "unauthorized". A phone revoked on suspicion of compromise and left in a drawer past
// the window is told "unauthorized" and keeps its offline record. 90 days is the session
// ceiling, and shortening it is not free.
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
