import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 043 (issue #801): generalize profile_share_links to also carry an
// ILLNESS-EPISODE share link, so the episode summary (#801) rides the ONE existing
// share-token code path (hashing, rate-limit, audit, revocation, listing) rather
// than a parallel table.
//
// A passport link scopes a set of `fields`; an episode link instead scopes ONE
// derived illness episode, addressed by (situation name + an anchor date inside it).
// The episode itself is DERIVED from the situation change-log at view time
// (episodeContainingDate), so nothing about the range is frozen here — a shared
// ongoing episode keeps growing, matching #801's "retrospective by construction".
//
// `kind` discriminates the two: 'passport' (the pre-existing behavior, the DEFAULT so
// every existing row reads unchanged) vs 'episode'. `episode_situation` / `episode_anchor`
// are NULL for passport links and set for episode links; `fields` stays NOT NULL so an
// episode row writes '[]' there. Additive columns only — the non-version-gated migrate()
// replay is a no-op via the column guard.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "profile_share_links");
  if (!cols.has("kind")) {
    db.exec(
      `ALTER TABLE profile_share_links
         ADD COLUMN kind TEXT NOT NULL DEFAULT 'passport'
         CHECK (kind IN ('passport', 'episode'));`
    );
  }
  if (!cols.has("episode_situation")) {
    db.exec(
      `ALTER TABLE profile_share_links ADD COLUMN episode_situation TEXT;`
    );
  }
  if (!cols.has("episode_anchor")) {
    db.exec(`ALTER TABLE profile_share_links ADD COLUMN episode_anchor TEXT;`);
  }
}

export const migration: Migration = {
  id: 44,
  name: "043-episode-share-links",
  up,
};
