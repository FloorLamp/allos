import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 022 (issue #470): a single-flight claim timestamp for OAuth token
// refresh on integration_connections.
//
// Strava (and Withings) ROTATE the refresh token on every refresh, so two processes
// refreshing the same connection concurrently — the web "Sync now" and the hourly
// notify tick — race: the loser presents an already-consumed refresh token, gets
// invalid_grant, and spuriously flips the connection to needs_reauth even though a
// valid pair was stored moments earlier. `refresh_claimed_at` lets exactly one process
// win the refresh via an atomic claim (claimTokenRefresh in connections.ts):
// `UPDATE ... SET refresh_claimed_at = now WHERE ... AND (refresh_claimed_at IS NULL
// OR refresh_claimed_at < now-60s)`. The loser skips the fetch and reuses the winner's
// fresh token (or its own not-yet-expired one). NULL for a connection never refreshed.
//
// Guarded ADD COLUMN so a replay of the whole migration list (the non-version-gated
// migrate() test wrapper) doesn't hit "duplicate column name"; production applies it
// exactly once behind the user_version gate. Determinism rule (spec): reads only the
// DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "integration_connections").has("refresh_claimed_at")) {
    db.exec(
      `ALTER TABLE integration_connections ADD COLUMN refresh_claimed_at TEXT;`
    );
  }
}

export const migration: Migration = {
  id: 22,
  name: "022-integration-refresh-claim",
  up,
};
