import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2879. The ledger-gated runner now skips applied historical migrations on
// repeat startup, so the inert columns and translation triggers retained solely for
// unconditional test replay can leave the final schema. Live values, ids, links,
// defaults, constraints, indexes, triggers, and AUTOINCREMENT high-water marks are
// copied unchanged. Historical migration files remain immutable.

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

function sequence(db: Database.Database, table: string): number | undefined {
  return (
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as
      { seq: number } | undefined
  )?.seq;
}

function restoreSequence(
  db: Database.Database,
  table: string,
  prior: number | undefined
): void {
  if (prior == null) return;
  const current = sequence(db, table);
  if (current == null) {
    db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(
      table,
      prior
    );
  } else if (current < prior) {
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
      prior,
      table
    );
  }
}

const LOG_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_insert
    AFTER INSERT ON intake_item_logs
    FOR EACH ROW WHEN NEW.product IS NULL
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;`,
  `CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_taken
    AFTER UPDATE OF status ON intake_item_logs
    FOR EACH ROW WHEN NEW.status = 'taken' AND OLD.status <> 'taken'
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;`,
];

function rebuildFoodEvents(db: Database.Database): void {
  if (!columns(db, "food_log_events").has("eaten_at")) return;
  const prior = sequence(db, "food_log_events");
  db.exec(`
    CREATE TABLE food_log_events__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      group_key TEXT NOT NULL,
      date TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      meal_slot TEXT CHECK (meal_slot IS NULL OR meal_slot IN ('Morning','Midday','Evening')),
      occurred_at TEXT,
      time_source TEXT CHECK (time_source IS NULL OR time_source IN ('tap','stated')),
      notify_message_id INTEGER REFERENCES notify_messages(id) ON DELETE SET NULL
    );
    INSERT INTO food_log_events__new
      (id, profile_id, group_key, date, recorded_at, created_at, meal_slot,
       occurred_at, time_source, notify_message_id)
      SELECT id, profile_id, group_key, date, recorded_at, created_at, meal_slot,
             occurred_at, time_source, notify_message_id FROM food_log_events;
    DROP TABLE food_log_events;
    ALTER TABLE food_log_events__new RENAME TO food_log_events;
    CREATE INDEX idx_food_log_events_profile
      ON food_log_events(profile_id, recorded_at DESC);
    CREATE INDEX idx_food_log_events_pop
      ON food_log_events(profile_id, date, group_key, recorded_at DESC);
    CREATE INDEX idx_food_log_events_notify_message
      ON food_log_events(notify_message_id);
  `);
  restoreSequence(db, "food_log_events", prior);
}

function rebuildEpisodes(db: Database.Database): void {
  if (!columns(db, "illness_episodes").has("started_at")) return;
  const prior = sequence(db, "illness_episodes");
  db.exec(`
    DROP TRIGGER IF EXISTS illness_episodes_legacy_window_compat;
    CREATE TABLE illness_episodes__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      situation TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      note TEXT,
      outcome TEXT
    );
    INSERT INTO illness_episodes__new
      (id, profile_id, situation, start_date, end_date, note, outcome)
      SELECT id, profile_id, situation, start_date, end_date, note, outcome
        FROM illness_episodes;
    DROP TABLE illness_episodes;
    ALTER TABLE illness_episodes__new RENAME TO illness_episodes;
    CREATE INDEX idx_illness_episodes_profile
      ON illness_episodes(profile_id, start_date);
    CREATE INDEX idx_illness_episodes_open
      ON illness_episodes(profile_id, situation, end_date);
  `);
  restoreSequence(db, "illness_episodes", prior);
}

function rebuildItems(db: Database.Database): void {
  if (!columns(db, "intake_items").has("as_needed")) return;
  const prior = sequence(db, "intake_items");
  db.exec(`
    DROP TRIGGER IF EXISTS intake_items_legacy_obligation_compat;
    CREATE TABLE intake_items__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      name TEXT NOT NULL, notes TEXT, active INTEGER NOT NULL DEFAULT 1,
      critical INTEGER NOT NULL DEFAULT 0, escalate_after_min INTEGER,
      escalate_chat_id TEXT, quantity_on_hand REAL,
      qty_per_dose REAL NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'supplement', prescriber TEXT, pharmacy TEXT,
      rx_number TEXT, document_id INTEGER REFERENCES medical_documents(id),
      source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      provider_id INTEGER REFERENCES providers(id),
      condition TEXT NOT NULL DEFAULT 'daily',
      obligation TEXT NOT NULL DEFAULT 'should' CHECK (obligation IN ('must','should','may')),
      brand TEXT, product TEXT, situation TEXT, stack TEXT, rxcui TEXT,
      rxcui_ingredients TEXT, situation_id INTEGER REFERENCES situations(id),
      min_interval_hours REAL CHECK (min_interval_hours IS NULL OR min_interval_hours > 0),
      max_daily_count INTEGER CHECK (max_daily_count IS NULL OR max_daily_count > 0),
      redose_notice INTEGER NOT NULL DEFAULT 0, rx INTEGER NOT NULL DEFAULT 0,
      last_fill_size REAL, encounter_id INTEGER REFERENCES encounters(id),
      source_record_id INTEGER REFERENCES medical_records(id),
      indication_condition_id INTEGER REFERENCES conditions(id), import_key TEXT,
      pause_situation_id INTEGER REFERENCES situations(id),
      supply_id INTEGER REFERENCES shared_supplies(id),
      cadence_kind TEXT NOT NULL DEFAULT 'daily'
        CHECK (cadence_kind IN ('daily','weekly','interval')),
      cadence_weekdays TEXT, cadence_interval_days INTEGER,
      cadence_anchor_date TEXT, max_daily_amount_mg REAL
    );
    INSERT INTO intake_items__new
      (id, profile_id, name, notes, active, critical, escalate_after_min,
       escalate_chat_id, quantity_on_hand, qty_per_dose, kind, prescriber,
       pharmacy, rx_number, document_id, source, created_at, provider_id,
       condition, obligation, brand, product, situation, stack, rxcui,
       rxcui_ingredients, situation_id, min_interval_hours, max_daily_count,
       redose_notice, rx, last_fill_size, encounter_id, source_record_id,
       indication_condition_id, import_key, pause_situation_id, supply_id,
       cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date,
       max_daily_amount_mg)
      SELECT id, profile_id, name, notes, active, critical, escalate_after_min,
       escalate_chat_id, quantity_on_hand, qty_per_dose, kind, prescriber,
       pharmacy, rx_number, document_id, source, created_at, provider_id,
       condition, obligation, brand, product, situation, stack, rxcui,
       rxcui_ingredients, situation_id, min_interval_hours, max_daily_count,
       redose_notice, rx, last_fill_size, encounter_id, source_record_id,
       indication_condition_id, import_key, pause_situation_id, supply_id,
       cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date,
       max_daily_amount_mg FROM intake_items;
    DROP TABLE intake_items;
    ALTER TABLE intake_items__new RENAME TO intake_items;
    CREATE INDEX idx_intake_items_document ON intake_items(profile_id, document_id);
    CREATE INDEX idx_intake_items_encounter ON intake_items(profile_id, encounter_id);
    CREATE INDEX idx_intake_items_import_key ON intake_items(profile_id, import_key);
    CREATE INDEX idx_intake_items_indication_condition
      ON intake_items(profile_id, indication_condition_id);
    CREATE INDEX idx_intake_items_source_record
      ON intake_items(profile_id, source_record_id);
    CREATE INDEX idx_intake_items_supply ON intake_items(supply_id);
  `);
  restoreSequence(db, "intake_items", prior);
}

function rebuildLogs(db: Database.Database): void {
  if (!columns(db, "intake_item_logs").has("given_at")) return;
  const prior = sequence(db, "intake_item_logs");
  db.exec(`
    CREATE TABLE intake_item_logs__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      occurred_at TEXT, amount TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
      skip_reason TEXT, product TEXT,
      supply_adjusted INTEGER NOT NULL DEFAULT 1 CHECK (supply_adjusted IN (0,1)),
      notify_message_id INTEGER REFERENCES notify_messages(id) ON DELETE SET NULL
    );
    INSERT INTO intake_item_logs__new
      (id, dose_id, item_id, date, recorded_at, occurred_at, amount, status,
       skip_reason, product, supply_adjusted, notify_message_id)
      SELECT id, dose_id, item_id, date, recorded_at, occurred_at, amount, status,
             skip_reason, product, supply_adjusted, notify_message_id
        FROM intake_item_logs;
    DROP TABLE intake_item_logs;
    ALTER TABLE intake_item_logs__new RENAME TO intake_item_logs;
    CREATE INDEX idx_intake_log_date ON intake_item_logs(date);
    CREATE INDEX idx_intake_log_dose_date ON intake_item_logs(dose_id, date);
    CREATE INDEX idx_intake_log_item_recorded
      ON intake_item_logs(item_id, COALESCE(occurred_at, recorded_at), id);
    CREATE INDEX idx_intake_item_logs_notify_message
      ON intake_item_logs(notify_message_id);
  `);
  for (const trigger of LOG_TRIGGERS) db.exec(trigger);
  restoreSequence(db, "intake_item_logs", prior);
}

export function up(db: Database.Database): void {
  rebuildFoodEvents(db);
  rebuildEpisodes(db);
  // These triggers select from intake_items, so SQLite requires them gone while that
  // parent table is swapped even with foreign-key enforcement disabled.
  db.exec(`
    DROP TRIGGER IF EXISTS intake_log_snapshot_product_insert;
    DROP TRIGGER IF EXISTS intake_log_snapshot_product_taken;
  `);
  rebuildItems(db);
  rebuildLogs(db);
  for (const trigger of LOG_TRIGGERS) db.exec(trigger);
}

export const migration: Migration = {
  name: "20260814-remove-legacy-schema-shells",
  up,
};
