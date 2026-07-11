import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 011 (issue #97): intake-family schema-debt cleanup. Pure hygiene — no
// behavior change. Three table rebuilds converge the shipped-since-baseline shape
// onto its intended one:
//
//   1. NAMING RESIDUE — rename the child FK column `supplement_id` → `item_id` on
//      BOTH `intake_item_doses` and `intake_item_logs`. The parent table has been
//      `intake_items` (supplements AND medications) since the supplements→intake
//      rename, so `supplement_id` misdescribes half its rows. The real
//      `REFERENCES intake_items(id) ON DELETE CASCADE` FK is preserved; the
//      `intake_item_logs.item_id` denormalized shortcut stays nullable (manual/
//      import rows can lack it) exactly as before. The doses index
//      (idx_intake_doses_item) is recreated on the renamed column.
//
//   2. REDUNDANT COLUMN (kept, not dropped) — `intake_item_logs.item_id` is fully
//      derivable via `dose_id → intake_item_doses.item_id`, but it is a live
//      denormalized JOIN shortcut (lib/timeline.ts and lib/export.ts join logs
//      straight to intake_items on `l.item_id` rather than two-hopping through the
//      dose). Grep confirms real readers depend on it, so dropping it would be a
//      query-shape change, not pure hygiene — it is KEPT and its drift is pinned by
//      a db-test consistency assertion (see intake-schema-debt.test.ts) instead.
//
//   3. UNORDERED PAIR MODELED AS ORDERED — `intake_item_pairs UNIQUE(a_id,b_id,
//      relation)` did not block the reversed duplicate `(b_id,a_id,relation)`. The
//      pair is direction-independent, so the rebuild adds `CHECK (a_id < b_id)`
//      (the UNIQUE now dedups both directions). Existing rows are canonicalized
//      into the new table (a_id/b_id swapped to a<b, self-pairs dropped, reversed
//      duplicates collapsed by INSERT OR IGNORE). The write path already normalizes
//      a<b (medicine/actions.reconcilePairs, seed, orderIntakePair), so this only
//      hardens the schema behind it.
//
// A rebuild is required because SQLite cannot rename a column or attach a CHECK in
// place. This follows the documented create-scratch → copy → drop → rename pattern
// (matching migration 006). The runner and the migrate() test wrapper apply every
// migration with foreign_keys DISABLED, so dropping a FK-PARENT table
// (intake_item_doses is the parent of intake_item_logs.dose_id; both are parents of
// nothing that would cascade-wipe here) does not fire ON DELETE CASCADE, and a child
// FK that references a table BY NAME follows the rename onto the rebuilt table.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB. Each rebuild is guarded by a sentinel read off the live schema (the
// renamed column present / the CHECK present), so a second run is a pure no-op.
// Production runs it exactly once behind the user_version gate. Determinism (spec):
// reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

// Rename intake_item_doses.supplement_id → item_id. Child intake_item_logs.dose_id
// references this table by name and follows the rename (FK enforcement is off).
function rebuildDoses(db: Database.Database): void {
  if (tableSql(db, "intake_item_doses") === null) return; // absent (partial handle)
  if (columnNames(db, "intake_item_doses").has("item_id")) return; // already converged
  db.exec(`
    CREATE TABLE intake_item_doses__new011 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      amount TEXT,
      time_of_day TEXT,
      food_timing TEXT NOT NULL DEFAULT 'any',
      sort INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO intake_item_doses__new011
      (id, item_id, amount, time_of_day, food_timing, sort, retired)
      SELECT id, supplement_id, amount, time_of_day, food_timing, sort, retired
        FROM intake_item_doses;
    DROP TABLE intake_item_doses;
    ALTER TABLE intake_item_doses__new011 RENAME TO intake_item_doses;
    CREATE INDEX IF NOT EXISTS idx_intake_doses_item ON intake_item_doses(item_id);
  `);
}

// Rename intake_item_logs.supplement_id → item_id (kept as a denormalized shortcut).
function rebuildLogs(db: Database.Database): void {
  if (tableSql(db, "intake_item_logs") === null) return; // absent (partial handle)
  if (columnNames(db, "intake_item_logs").has("item_id")) return; // already converged
  db.exec(`
    CREATE TABLE intake_item_logs__new011 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      amount TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
      skip_reason TEXT,
      UNIQUE (dose_id, date)
    );
    INSERT INTO intake_item_logs__new011
      (id, dose_id, item_id, date, taken_at, amount, status, skip_reason)
      SELECT id, dose_id, supplement_id, date, taken_at, amount, status, skip_reason
        FROM intake_item_logs;
    DROP TABLE intake_item_logs;
    ALTER TABLE intake_item_logs__new011 RENAME TO intake_item_logs;
    CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);
  `);
}

// Enforce canonical ordering on intake_item_pairs with CHECK (a_id < b_id). Existing
// rows are canonicalized: a<b via CASE, self-pairs (a_id = b_id) dropped, and
// reversed duplicates collapsed by INSERT OR IGNORE against UNIQUE(a_id,b_id,relation)
// — earliest id wins (ORDER BY id).
function rebuildPairs(db: Database.Database): void {
  const sql = tableSql(db, "intake_item_pairs");
  if (sql === null) return; // absent (partial handle)
  if (sql.includes("a_id < b_id")) return; // already converged
  db.exec(`
    CREATE TABLE intake_item_pairs__new011 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'separate' CHECK (relation IN ('with','separate')),
      note TEXT,
      UNIQUE (a_id, b_id, relation),
      CHECK (a_id < b_id)
    );
    INSERT OR IGNORE INTO intake_item_pairs__new011 (id, a_id, b_id, relation, note)
      SELECT id,
             CASE WHEN a_id < b_id THEN a_id ELSE b_id END,
             CASE WHEN a_id < b_id THEN b_id ELSE a_id END,
             relation, note
        FROM intake_item_pairs
       WHERE a_id <> b_id
       ORDER BY id;
    DROP TABLE intake_item_pairs;
    ALTER TABLE intake_item_pairs__new011 RENAME TO intake_item_pairs;
  `);
}

export function up(db: Database.Database): void {
  // MUST run with foreign_keys disabled (the runner and migrate() both toggle it off
  // around application) so the drop of a FK-parent table does not cascade-wipe its
  // children. One transaction for atomicity — nests as a SAVEPOINT under the runner's
  // IMMEDIATE txn, becomes the transaction under migrate()'s autocommit.
  const run = db.transaction(() => {
    rebuildDoses(db);
    rebuildLogs(db);
    rebuildPairs(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 11,
  name: "011-intake-schema-debt",
  up,
};
