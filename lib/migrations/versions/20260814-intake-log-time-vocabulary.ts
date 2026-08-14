import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2876 completes the intake ledger's event/record split. The old table used
// `taken_at` for the immutable insert stamp and overloaded `recorded_at` with the
// administration instant that corrections mutate. The final vocabulary matches the
// food ledger: `recorded_at` is immutable capture; `occurred_at` is the event.
//
// Both live instants move onto the canonical UTC+Z convention while their values are
// copied. Existing `occurred_at` wins; otherwise the administration instant currently
// stored in `recorded_at` fills it. The old `taken_at` becomes the new `recorded_at`.
// No day, id, status, supply, attribution, or parent link changes.
//
// The inert `given_at` shell remains until #2879 removes the historical-migration
// replay requirement that keeps it alive. Shipped migrations are not edited.

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

function columns(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare("PRAGMA table_info(intake_item_logs)").all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
}

function preserveSequence(
  db: Database.Database,
  prior: number | undefined
): void {
  if (prior == null) return;
  const row = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'intake_item_logs'")
    .get() as { seq: number } | undefined;
  if (row == null) {
    db.prepare(
      "INSERT INTO sqlite_sequence(name, seq) VALUES ('intake_item_logs', ?)"
    ).run(prior);
  } else if (row.seq < prior) {
    db.prepare(
      "UPDATE sqlite_sequence SET seq = ? WHERE name = 'intake_item_logs'"
    ).run(prior);
  }
}

function canonicalInstant(
  db: Database.Database,
  value: unknown
): string | null {
  if (typeof value !== "string") return null;
  const parsed = (
    db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?) AS value")
      .get(value) as { value: string | null }
  ).value;
  return parsed ?? value;
}

export function up(db: Database.Database): void {
  const cols = columns(db);
  if (cols.size === 0 || !cols.has("taken_at")) return;

  const prior = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'intake_item_logs'")
    .get() as { seq: number } | undefined;

  // Undo payloads are stored rows too. Rewrite outstanding administration tokens so
  // restoring one after this migration cannot reintroduce the retired vocabulary or
  // swap the event and record instants.
  const undoRows = db
    .prepare(
      "SELECT id, payload FROM deleted_rows WHERE kind = 'administration'"
    )
    .all() as { id: number; payload: string }[];
  const updateUndo = db.prepare(
    "UPDATE deleted_rows SET payload = ? WHERE id = ?"
  );
  for (const row of undoRows) {
    try {
      const payload = JSON.parse(row.payload) as {
        administration?: Record<string, unknown>;
      };
      const administration = payload.administration;
      if (!administration || typeof administration.taken_at !== "string") {
        continue;
      }
      const oldRecordedAt = administration.recorded_at;
      administration.recorded_at = canonicalInstant(
        db,
        administration.taken_at
      );
      administration.occurred_at = canonicalInstant(
        db,
        administration.occurred_at ?? oldRecordedAt
      );
      delete administration.taken_at;
      updateUndo.run(JSON.stringify(payload), row.id);
    } catch {
      // Malformed undo payloads were already unrestorable; leave them untouched.
    }
  }

  db.exec(`
    CREATE TABLE intake_item_logs__new_2876 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      recorded_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      occurred_at TEXT,
      amount TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
      skip_reason TEXT,
      product TEXT,
      supply_adjusted INTEGER NOT NULL DEFAULT 1
        CHECK (supply_adjusted IN (0, 1)),
      notify_message_id INTEGER REFERENCES notify_messages(id)
        ON DELETE SET NULL,
      given_at TEXT
    );
    INSERT INTO intake_item_logs__new_2876
      (id, dose_id, item_id, date, recorded_at, occurred_at, amount, status,
       skip_reason, product, supply_adjusted, notify_message_id, given_at)
      SELECT id, dose_id, item_id, date,
             strftime('%Y-%m-%dT%H:%M:%SZ', taken_at),
             CASE
               WHEN occurred_at IS NOT NULL
                 THEN strftime('%Y-%m-%dT%H:%M:%SZ', occurred_at)
               WHEN recorded_at IS NOT NULL
                 THEN strftime('%Y-%m-%dT%H:%M:%SZ', recorded_at)
               ELSE NULL
             END,
             amount, status, skip_reason, product, supply_adjusted,
             notify_message_id, given_at
        FROM intake_item_logs;
    DROP TABLE intake_item_logs;
    ALTER TABLE intake_item_logs__new_2876 RENAME TO intake_item_logs;
    CREATE INDEX idx_intake_log_date ON intake_item_logs(date);
    CREATE INDEX idx_intake_log_dose_date ON intake_item_logs(dose_id, date);
    CREATE INDEX idx_intake_log_item_given
      ON intake_item_logs(item_id, COALESCE(occurred_at, recorded_at), id);
    CREATE INDEX idx_intake_item_logs_notify_message
      ON intake_item_logs(notify_message_id);
  `);
  for (const trigger of TRIGGERS) db.exec(trigger);
  preserveSequence(db, prior?.seq);
}

export const migration: Migration = {
  name: "20260814-intake-log-time-vocabulary",
  up,
};
