import type Database from "better-sqlite3";
import {
  normalizePracticeName,
  practiceIdentity,
  practiceSignalKey,
} from "../../practice";
import type { Migration } from "../runner";

// Migration 123 (issue #1623): one named wellness-practice target per normalized
// identity and profile. practiceIdentity() deliberately folds case and whitespace,
// which SQLite's built-in NOCASE collation cannot express. Persist that exact key in
// scope_identity, require it on every practice write, and unique-index the key only
// for practice rows (the other frequency-target scopes keep their existing rules).
//
// Existing race artifacts are reconciled before the index is created. The oldest
// target owns the identity: protocols are re-pointed to it, id-keyed suppression is
// transferred when possible, matching name-keyed practice logs are re-keyed to its
// normalized display spelling, and later targets are removed.

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((row) => row.name === column);
}

interface PracticeTargetRow {
  id: number;
  profile_id: number;
  scope_value: string;
}

interface PracticeLogRow {
  id: number;
  profile_id: number;
  practice: string;
}

export function up(db: Database.Database): void {
  const hasFrequencyTargets = db
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'frequency_targets'`
    )
    .get();
  if (!hasFrequencyTargets) return;

  const run = db.transaction(() => {
    if (!hasColumn(db, "frequency_targets", "scope_identity")) {
      db.exec(`ALTER TABLE frequency_targets ADD COLUMN scope_identity TEXT`);
    }

    const rows = db
      .prepare(
        `SELECT id, profile_id, scope_value
           FROM frequency_targets
          WHERE scope_kind = 'practice'
          ORDER BY id`
      )
      .all() as PracticeTargetRow[];

    const keepers = new Map<
      number,
      Map<string, { id: number; name: string }>
    >();
    for (const row of rows) {
      const identity = practiceIdentity(row.scope_value);
      const name = normalizePracticeName(row.scope_value);
      let profileKeepers = keepers.get(row.profile_id);
      if (!profileKeepers) {
        profileKeepers = new Map();
        keepers.set(row.profile_id, profileKeepers);
      }

      const keeper = profileKeepers.get(identity);
      if (!keeper) {
        profileKeepers.set(identity, { id: row.id, name });
        db.prepare(
          `UPDATE frequency_targets
              SET scope_value = ?, scope_identity = ?
            WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
        ).run(name, identity, row.id, row.profile_id);
        continue;
      }

      db.prepare(
        `UPDATE protocols
            SET frequency_target_id = ?
          WHERE profile_id = ? AND frequency_target_id = ?`
      ).run(keeper.id, row.profile_id, row.id);

      const keeperSignal = practiceSignalKey(keeper.id);
      const loserSignal = practiceSignalKey(row.id);
      db.prepare(
        `UPDATE OR IGNORE upcoming_dismissals
            SET signal_key = ?
          WHERE profile_id = ? AND signal_key = ?`
      ).run(keeperSignal, row.profile_id, loserSignal);
      db.prepare(
        `DELETE FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key = ?`
      ).run(row.profile_id, loserSignal);

      db.prepare(
        `DELETE FROM frequency_targets
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
      ).run(row.id, row.profile_id);
    }

    const logs = db
      .prepare(`SELECT id, profile_id, practice FROM practice_logs ORDER BY id`)
      .all() as PracticeLogRow[];
    for (const log of logs) {
      const keeper = keepers
        .get(log.profile_id)
        ?.get(practiceIdentity(log.practice));
      if (!keeper || log.practice === keeper.name) continue;
      db.prepare(
        `UPDATE practice_logs
            SET practice = ?, edited = 1
          WHERE id = ? AND profile_id = ?`
      ).run(keeper.name, log.id, log.profile_id);
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_frequency_targets_practice_identity_unique
        ON frequency_targets(profile_id, scope_identity)
        WHERE scope_kind = 'practice';

      CREATE TRIGGER IF NOT EXISTS trg_frequency_targets_practice_identity_insert
      BEFORE INSERT ON frequency_targets
      WHEN NEW.scope_kind = 'practice' AND NEW.scope_identity IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'practice scope_identity is required');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_frequency_targets_practice_identity_update
      BEFORE UPDATE OF scope_kind, scope_identity ON frequency_targets
      WHEN NEW.scope_kind = 'practice' AND NEW.scope_identity IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'practice scope_identity is required');
      END;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 123,
  name: "123-practice-target-unique",
  up,
};
