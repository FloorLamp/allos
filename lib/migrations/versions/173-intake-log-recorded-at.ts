import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 173 (issue #2205, phase 2 wave 2): `intake_item_logs.given_at` becomes
// `recorded_at` — the name finally matching the meaning.
//
// The owner's #2229 ruling settled what this column IS: a RECORD instant. A scheduled
// confirm writes the TAP moment into it, standing in for an intake the app never
// observed, so it has been a `recorded_at` wearing an event's name — which is why a
// dozen readers hand-rolled `COALESCE(given_at, taken_at)` and were right to: both
// links answer "when did this enter the app", and the fallback was WITHIN one question
// all along. Wave 1 (migration 165) added the event instant this table never had,
// `occurred_at`, populated only when somebody actually states a time; #2228's write
// half then pointed the amend path at it and left `given_at` read-only history. This
// migration is the last piece: the rename, with every reader moved in the same change
// (no shim, no dual-read period — #2205 constraint 3).
//
// NOTHING ELSE MOVES. Values are copied verbatim (still SQLite's bare shape, still the
// same rows), `date` semantics are untouched (#2205 constraint 4), and the PRN redose
// window and the phantom-dose proximity guard read the same instants they did before —
// only the column they name changes.
//
// WHY `taken_at` KEEPS ITS NAME. The declared vocabulary has exactly ONE word for "when
// it entered the app", and this table has TWO columns answering it. `recorded_at` goes
// to the link readers actually reach. The other word on offer, `created_at`, is declared
// BOOKKEEPING — "a stamp that is not the fact the row records" — while `taken_at` IS
// reached as a record answer whenever nothing more precise was written (a SKIP writes no
// `recorded_at` and falls through to it). Renaming it `created_at` while declaring it
// `record` would install exactly the name/meaning mismatch this wave removes; declaring
// it `bookkeeping` to earn the name would drop a chain link and change what
// `recordInstant` returns for every skipped dose — a behaviour change, not a rename. So
// it stays until #2205 grows a word for "the insert stamp BEHIND a more precise record
// instant". See lib/time-columns.ts for the same reasoning next to the declarations.
//
// ── THE VESTIGIAL `given_at` COLUMN (the migration-124/169 pattern) ──────────
//
// The rebuilt table keeps an inert `given_at`, always NULL. Not a hedge: `migrate()`
// (lib/db.ts) replays EVERY migration unconditionally for the DB-test harness, and two
// shipped, immutable migrations reach for that column name on a database that has
// already been through this one:
//
//   • 041 guards its whole administration-ledger REBUILD on `given_at` being present
//     ("converged"). Without the shell, a replay would decide the table still needs
//     rebuilding and then run an INSERT…SELECT naming columns that no longer exist —
//     SQLite validates names at PREPARE time, so it throws before touching a row.
//   • 156 re-creates `idx_intake_log_item_given` over `(item_id, given_at)`.
//
// A compat TRIGGER (169's other half) is NOT needed here: no migration INSERTS into
// intake_item_logs, so there is no legacy write whose intent has to be translated — the
// two statements above are a guard read and a CREATE INDEX. lib/time-columns.ts declares
// the shell as `bookkeeping` rather than `record` on purpose, so a dead column cannot
// join the record chain lib/row-instants.ts walks.
//
// THE INDEX KEEPS ITS NAME for the same reason, pointed at the new column:
// `idx_intake_log_item_given ON (item_id, recorded_at)`. Renaming it would make 156's
// `CREATE INDEX IF NOT EXISTS` miss on a replay and build a second, dead index over the
// vestigial column — which is both waste and a schema change under a wrapper whose
// contract is that a replay changes nothing (lib/__db_tests__/migrate.test.ts pins it).
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//
// A rebuild, not an `ALTER TABLE … RENAME COLUMN`: the house pattern (124/163/169) is
// CREATE __new → INSERT…SELECT → DROP → RENAME → re-create indexes and triggers, and it
// is what keeps the whole swap one statement sequence with the vestigial column added in
// the same breath. The runner (and migrate()) apply migrations with foreign_keys
// DISABLED, so dropping this table — a FK CHILD of intake_item_doses / intake_items /
// notify_messages, and a parent of nothing — neither cascades nor loses its own links:
// the copy carries every FK value verbatim and the recreated table re-declares the same
// references. No link is newly enforced, so there is nothing to null beforehand.
//
// AUTOINCREMENT high-water mark: log ids are external identity (Telegram dose callbacks,
// the correction-burst anchors, the undo registry's captured row), so they must never
// recycle — and a DROP discards the sqlite_sequence entry. The old `seq` is captured
// first and restored after the rename when the copy's own max id came in lower (e.g. the
// newest administration had been deleted).
//
// REPLAY-SAFE. Guarded on the stored table SQL: once the table carries `recorded_at` the
// migration is a pure no-op, so the copy can never run twice. Determinism (spec): reads
// only the DB catalog and its own constants.

// The migration-079 snapshot triggers, verbatim (the 124 pattern — a rebuild drops the
// table's triggers with it, so they are re-created after the rename). Spelled `IF NOT
// EXISTS` so a replayed 079/124 finds them already there.
const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_insert
    AFTER INSERT ON intake_item_logs
    FOR EACH ROW
    WHEN NEW.product IS NULL
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;`,
  `CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_taken
    AFTER UPDATE OF status ON intake_item_logs
    FOR EACH ROW
    WHEN NEW.status = 'taken' AND OLD.status <> 'taken'
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;`,
];

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
  const sql = tableSql(db, "intake_item_logs");
  // Absent (a partial handle), or already converged — either way, nothing to do.
  if (sql === "" || sql.includes("recorded_at")) return;

  const prior = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'intake_item_logs'`)
    .get() as { seq: number } | undefined;

  db.exec(`
    CREATE TABLE intake_item_logs__new173 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      recorded_at TEXT,
      amount TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
      skip_reason TEXT,
      product TEXT,
      supply_adjusted INTEGER NOT NULL DEFAULT 1
        CHECK (supply_adjusted IN (0, 1)),
      occurred_at TEXT,
      notify_message_id INTEGER REFERENCES notify_messages(id)
        ON DELETE SET NULL,
      -- VESTIGIAL, always NULL. Nothing reads or writes it; recorded_at above
      -- replaced it (#2205 phase 2 wave 2). It survives for exactly one reason:
      -- migrate() (lib/db.ts) applies EVERY migration unconditionally, and the frozen
      -- migrations 041 (its convergence guard) and 156 (its index) name this column.
      given_at TEXT
    );
    INSERT INTO intake_item_logs__new173
      (id, dose_id, item_id, date, taken_at, recorded_at, amount, status,
       skip_reason, product, supply_adjusted, occurred_at, notify_message_id)
      SELECT id, dose_id, item_id, date, taken_at, given_at, amount, status,
             skip_reason, product, supply_adjusted, occurred_at, notify_message_id
        FROM intake_item_logs;
    DROP TABLE intake_item_logs;
    ALTER TABLE intake_item_logs__new173 RENAME TO intake_item_logs;
    CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);
    CREATE INDEX IF NOT EXISTS idx_intake_log_dose_date
      ON intake_item_logs(dose_id, date);
    -- Migration 156's composite, on the renamed column under its original NAME (see
    -- the header): the arming-administration read is still a seek, not a ledger scan.
    CREATE INDEX IF NOT EXISTS idx_intake_log_item_given
      ON intake_item_logs(item_id, recorded_at);
    -- Migration 170's FK-side index, so pruning notify_messages still resolves its
    -- children without scanning the ledger.
    CREATE INDEX IF NOT EXISTS idx_intake_item_logs_notify_message
      ON intake_item_logs(notify_message_id);
  `);
  for (const t of TRIGGERS) db.exec(t);

  if (prior != null) {
    // Restore the pre-rebuild high-water mark when it exceeds the copied rows' own max
    // (the INSERT re-seeded sqlite_sequence only up to the surviving max id, and an
    // empty table re-created no entry at all). sqlite_sequence carries no unique
    // constraint, so the upsert is spelled out.
    const now = db
      .prepare(
        `SELECT seq FROM sqlite_sequence WHERE name = 'intake_item_logs'`
      )
      .get() as { seq: number } | undefined;
    if (now == null) {
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq) VALUES ('intake_item_logs', ?)`
      ).run(prior.seq);
    } else if (now.seq < prior.seq) {
      db.prepare(
        `UPDATE sqlite_sequence SET seq = ? WHERE name = 'intake_item_logs'`
      ).run(prior.seq);
    }
  }
}

export const migration: Migration = {
  id: 173,
  name: "173-intake-log-recorded-at",
  up,
};
