import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 101 (issue #1096): the persisted multi-profile VIEW-SET on the session.
//
// A session already carries ONE `active_profile_id` — the single WRITE target (the
// "acting" profile). Multi-profile VIEWING (#1096) adds a READ overlay on top of it:
// the set of accessible profiles whose data a multi-view page merges. That set is
// per-session UI state, so it rides the session row as `view_profile_ids` — a JSON
// array of profile ids (e.g. "[1,2]"), or NULL for the default single-view (just the
// acting profile).
//
// NOT AN AUTH BOUNDARY. The stored ids are UNTRUSTED and re-validated on EVERY read
// through resolveScope (lib/scope.ts): the raw set is intersected with the login's
// CURRENT accessible set, so a revoked grant silently drops out of the view and a
// tampered id can never widen it (the same "re-derive against current grants" stance
// resolveSessionToken already takes for active_profile_id). Writes are unaffected —
// they still land in exactly ONE profile via the existing write gates; only reads
// consult the view-set. So this column is pure display state, never a capability.
//
// Nullable, no default, no index: it's read only alongside the session row that the
// token lookup already fetches (a PRIMARY KEY probe), and a NULL means "single view"
// so an un-migrated session and a never-touched one behave identically — zero
// regression on rollout. CREATE-style additive ALTER keeps the non-version-gated
// migrate() replay a no-op (the column already exists on a current DB).

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "view_profile_ids")) {
    db.exec("ALTER TABLE sessions ADD COLUMN view_profile_ids TEXT");
  }
}

export const migration: Migration = {
  id: 101,
  name: "101-session-view-profiles",
  up,
};
