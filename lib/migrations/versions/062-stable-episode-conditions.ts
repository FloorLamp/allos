import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 062: re-anchor episode-sourced Conditions to the illness episode's stable
// row id. The original promotion key embedded (situation, started_at), so correcting an
// episode boundary detached its Condition and allowed a duplicate promotion. It also
// meant an episode ended after promotion could leave an active Condition behind.
//
// Match only the exact legacy external_id emitted by the old code. This never guesses
// from condition names or dates and therefore never touches hand-entered/imported rows.
// When duplicate episode rows share the same legacy tuple, the newest stable row wins,
// mirroring the row resolver's id-desc tie-break. Alongside the re-key, repair the
// generated condition's episode-owned name/range/status fields.

interface LegacyEpisodeCondition {
  condition_id: number;
  profile_id: number;
  episode_id: number;
  situation: string;
  started_at: string | null;
  ended_at: string | null;
}

export function stabilizeEpisodeConditions(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT c.id AS condition_id, c.profile_id AS profile_id,
              ie.id AS episode_id, ie.situation AS situation,
              ie.started_at AS started_at, ie.ended_at AS ended_at
         FROM conditions c
         JOIN illness_episodes ie
           ON ie.id = (
             SELECT candidate.id
               FROM illness_episodes candidate
              WHERE candidate.profile_id = c.profile_id
                AND c.external_id =
                    'episode:' || lower(trim(candidate.situation)) || ':' ||
                    COALESCE(candidate.started_at, 'open')
              ORDER BY candidate.id DESC
              LIMIT 1
           )
        WHERE c.profile_id = ie.profile_id
          AND c.source = 'episode'
          AND c.external_id LIKE 'episode:%'`
    )
    .all() as LegacyEpisodeCondition[];

  const update = db.prepare(
    `UPDATE conditions
        SET external_id = ?, name = ?, status = ?, onset_date = ?,
            resolved_date = CASE WHEN ? IS NULL THEN NULL ELSE date(?, '-1 day') END
      WHERE id = ? AND profile_id = ? AND source = 'episode'`
  );
  for (const row of rows) {
    update.run(
      `illness-episode:${row.episode_id}`,
      row.situation,
      row.ended_at == null ? "active" : "resolved",
      row.started_at,
      row.ended_at,
      row.ended_at,
      row.condition_id,
      row.profile_id
    );
  }
}

export function up(db: Database.Database): void {
  stabilizeEpisodeConditions(db);
}

export const migration: Migration = {
  id: 62,
  name: "062-stable-episode-conditions",
  up,
};
