import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { parseSituationEvents } from "../../trend-annotations";
import { episodesForSituation } from "../../symptom-episode";

// Migration 046 (issue #856): give illness episodes a STABLE IDENTITY.
//
// Until now an "episode" was purely DERIVED — a [start, end) window reconstructed
// from the situation change-log (lib/symptom-episode.ts). That was right while an
// episode had no user-owned state, but #856 gives episodes annotations (a free-text
// note, an outcome) and user-edited boundaries — and you cannot hang state off an
// entity whose identity is a mutable date tuple (edit the start date and the identity
// changes under its own note; the #203 date/name-keyed-state disease). So episodes get
// a thin table: IDENTITY + ANNOTATIONS ONLY. MEMBERSHIP (which symptoms/temps/meds/
// clinical events belong to an episode) stays DERIVED by date-range — nothing carries
// an FK to an episode, so an edited/retro episode is automatically correct.
//
//   illness_episodes — one row per illness episode. `started_at`/`ended_at` carry the
//   SAME semantics as the derived IllnessEpisode: `started_at` = inclusive first active
//   day (YYYY-MM-DD; NULL = active before the capped change-log), `ended_at` = EXCLUSIVE
//   end (the first inactive day; NULL = open/ongoing). Keeping these identical to the
//   derived tuple is what makes assembleIllnessEpisode byte-identical pre/post swap.
//   Profile-OWNED (born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`), so it
//   joins OWNED_TABLES.
//
// The flagged-situation toggle now OPENS/CLOSES a row in the SAME writeTx that flips
// situations.active (lib/settings/profile-attrs.ts → syncOpenIllnessEpisode), so the
// active-situation set and the open row never disagree. Boundary edits/retro-create/
// merge (item 1) become plain row edits, not change-log surgery.
//
// profile_share_links gains a nullable `episode_id` FK so an episode share link can
// re-anchor to the STABLE id (surviving boundary edits) instead of the situation+anchor
// date; the resolver keeps the old anchor-date path as a graceful fallback for links
// minted before this migration (SQLite allows ADD COLUMN … REFERENCES only for a
// NULL-default column, which this is).
//
// BACKFILL: deterministically reconstruct one row per historical flagged on→off range
// from the existing change-log (episodesForSituation), so nothing is lost in the swap.
// Runs exactly once (version-gated); reads only the DB + pure list math.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

// Reconstruct illness_episodes rows from every profile's situation change-log. Exported
// so the DB-tier test can drive the identical reconstruction over a seeded fixture
// (the "historical ranges become rows" acceptance). Pure inputs: the situations table,
// the stored situation_events blob, and the episodesForSituation pairing.
export function backfillIllnessEpisodes(db: Database.Database): void {
  const profiles = db.prepare(`SELECT id FROM profiles ORDER BY id`).all() as {
    id: number;
  }[];
  const insert = db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, ?, ?, ?)`
  );
  for (const { id: profileId } of profiles) {
    const situations = db
      .prepare(
        `SELECT name, active FROM situations
          WHERE profile_id = ? AND illness_type = 1`
      )
      .all(profileId) as { name: string; active: number }[];
    if (situations.length === 0) continue;
    const eventsRow = db
      .prepare(
        `SELECT value FROM profile_settings
          WHERE profile_id = ? AND key = 'situation_events'`
      )
      .get(profileId) as { value?: string } | undefined;
    const events = parseSituationEvents(eventsRow?.value);
    for (const s of situations) {
      for (const ep of episodesForSituation(s.name, events, !!s.active)) {
        insert.run(profileId, s.name, ep.start, ep.end);
      }
    }
  }
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS illness_episodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      situation  TEXT NOT NULL,
      started_at TEXT,
      ended_at   TEXT,
      note       TEXT,
      outcome    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_profile
      ON illness_episodes(profile_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_open
      ON illness_episodes(profile_id, situation, ended_at);
  `);

  if (!columnNames(db, "profile_share_links").has("episode_id")) {
    db.exec(
      `ALTER TABLE profile_share_links
         ADD COLUMN episode_id INTEGER REFERENCES illness_episodes(id);`
    );
  }

  backfillIllnessEpisodes(db);
}

export const migration: Migration = {
  id: 46,
  name: "046-illness-episodes",
  up,
};
