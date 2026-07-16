import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 048 (issue #852 item 4): grow the profile_share_links `kind` CHECK to admit
// a 'medications' link — a tokenized share of the profile's CURRENT medication list,
// the #801 episode-summary precedent applied to the med list. SQLite can't ALTER a
// CHECK in place, so this is a create→copy→drop→rename rebuild (the AGENTS.md "grow an
// enum CHECK" pattern). The runner applies migrations with foreign_keys disabled and
// restores after, so dropping the table doesn't cascade its FK children.
//
// Guarded on the stored table SQL so the non-version-gated migrate() replay is a no-op
// once the CHECK already lists 'medications'. All columns (baseline + 044 kind/episode_*
// + 046 episode_id) are preserved in their existing order.

function tableSql(db: Database.Database, name: string): string {
  return (
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name) as { sql: string } | undefined
    )?.sql ?? ""
  );
}

export function up(db: Database.Database): void {
  if (tableSql(db, "profile_share_links").includes("'medications'")) return;

  db.exec(`
    CREATE TABLE profile_share_links__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      token_hash TEXT NOT NULL UNIQUE,
      fields TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES logins(id) ON DELETE SET NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL DEFAULT 'passport'
        CHECK (kind IN ('passport', 'episode', 'medications')),
      episode_situation TEXT,
      episode_anchor TEXT,
      episode_id INTEGER REFERENCES illness_episodes(id)
    );
    INSERT INTO profile_share_links__new
      (id, profile_id, token_hash, fields, expires_at, created_by, revoked_at,
       created_at, kind, episode_situation, episode_anchor, episode_id)
      SELECT id, profile_id, token_hash, fields, expires_at, created_by, revoked_at,
             created_at, kind, episode_situation, episode_anchor, episode_id
        FROM profile_share_links;
    DROP TABLE profile_share_links;
    ALTER TABLE profile_share_links__new RENAME TO profile_share_links;
    CREATE INDEX IF NOT EXISTS idx_share_links_profile
      ON profile_share_links(profile_id);
  `);
}

export const migration: Migration = {
  id: 48,
  name: "048-medications-share-kind",
  up,
};
