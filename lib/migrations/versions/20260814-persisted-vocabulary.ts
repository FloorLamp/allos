import type Database from "better-sqlite3";
import type { Migration } from "../runner";

const OLD_UNDO_KIND = "biomarker-record";
const UNDO_KIND = "clinical-observation";

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function assertEmptyReplayTable(db: Database.Database, table: string): void {
  const { count } = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  if (count !== 0) {
    throw new Error(
      `Refusing to discard populated replay table ${table} after its daily-total replacement already exists`
    );
  }
}

function renameDailyTotal(
  db: Database.Database,
  from: string,
  to: string,
  oldIndex: string,
  newIndex: string
): void {
  if (tableExists(db, to)) {
    if (tableExists(db, from)) {
      assertEmptyReplayTable(db, from);
      db.exec(`DROP TABLE ${from};`);
    }
    return;
  }
  if (!tableExists(db, from)) return;
  db.exec(`
    ALTER TABLE ${from} RENAME TO ${to};
    DROP INDEX IF EXISTS ${oldIndex};
    CREATE INDEX ${newIndex} ON ${to}(profile_id, date DESC);
  `);
}

function sqliteSequence(db: Database.Database, table: string): number {
  const row = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = ?")
    .get(table) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function preserveSqliteSequence(
  db: Database.Database,
  table: string,
  sequence: number
): void {
  const result = db
    .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?")
    .run(sequence, table);
  if (result.changes === 0) {
    db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(
      table,
      sequence
    );
  }
}

function renameSubstanceDailyTotals(db: Database.Database): void {
  if (tableExists(db, "substance_daily_totals")) {
    if (tableExists(db, "substance_log")) {
      assertEmptyReplayTable(db, "substance_log");
      db.exec("DROP TABLE substance_log;");
    }
    db.exec(`
      UPDATE substance_daily_totals
         SET source = 'manual'
       WHERE source = 'user';
    `);
    return;
  }
  if (!tableExists(db, "substance_log")) return;

  const sequence = sqliteSequence(db, "substance_log");
  db.exec(`
    CREATE TABLE substance_daily_totals_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      substance  TEXT NOT NULL,
      units      INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
      logged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source     TEXT NOT NULL DEFAULT 'manual',
      edited     INTEGER NOT NULL DEFAULT 0,
      notes      TEXT,
      UNIQUE (profile_id, date, substance)
    );
    INSERT INTO substance_daily_totals_new
      (id, profile_id, date, substance, units, logged_at, created_at, source,
       edited, notes)
      SELECT id, profile_id, date, substance, units, logged_at, created_at,
             CASE WHEN source = 'user' THEN 'manual' ELSE source END,
             edited, notes
        FROM substance_log;
    DROP TABLE substance_log;
    ALTER TABLE substance_daily_totals_new RENAME TO substance_daily_totals;
    CREATE INDEX idx_substance_daily_totals_profile
      ON substance_daily_totals(profile_id, date DESC);
  `);
  preserveSqliteSequence(db, "substance_daily_totals", sequence);
}

function renameImportResult(json: string | null): string | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { type?: unknown }).type !== "biomarkers"
    ) {
      return json;
    }
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      type: "clinical-results",
    });
  } catch {
    return json;
  }
}

interface ImportJobRow {
  id: number;
  profile_id: number;
  type: string;
  status: string;
  source_text: string | null;
  result_json: string | null;
  summary: string | null;
  error: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

function renameImportJobType(db: Database.Database): void {
  const sql = tableSql(db, "import_jobs");
  if (sql == null) return;
  if (sql.includes("'clinical-results'")) return;

  const sequence = sqliteSequence(db, "import_jobs");
  const rows = db
    .prepare(
      `SELECT id, profile_id, type, status, source_text, result_json, summary,
              error, model, created_at, updated_at
         FROM import_jobs
        ORDER BY id`
    )
    .all() as ImportJobRow[];

  db.exec(`
    CREATE TABLE import_jobs__vocabulary_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      type TEXT NOT NULL CHECK (type IN ('workouts','clinical-results')),
      status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing','ready','committing','failed','skipped')),
      source_text TEXT,
      result_json TEXT,
      summary TEXT,
      error TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare(
    `INSERT INTO import_jobs__vocabulary_new
       (id, profile_id, type, status, source_text, result_json, summary, error,
        model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.profile_id,
      row.type === "biomarkers" ? "clinical-results" : row.type,
      row.status,
      row.source_text,
      renameImportResult(row.result_json),
      row.summary,
      row.error,
      row.model,
      row.created_at,
      row.updated_at
    );
  }
  db.exec(`
    DROP TABLE import_jobs;
    ALTER TABLE import_jobs__vocabulary_new RENAME TO import_jobs;
    CREATE INDEX idx_import_jobs_created ON import_jobs(created_at);
  `);
  preserveSqliteSequence(db, "import_jobs", sequence);
}

function renameProtocolOutcomes(db: Database.Database): void {
  if (!tableExists(db, "protocols")) return;
  const rows = db
    .prepare("SELECT id, outcome_keys FROM protocols ORDER BY id")
    .all() as { id: number; outcome_keys: string }[];
  const update = db.prepare(
    "UPDATE protocols SET outcome_keys = ? WHERE id = ?"
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.outcome_keys);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const seen = new Set<string>();
    const renamed: unknown[] = [];
    let changed = false;
    for (const value of parsed) {
      const next =
        typeof value === "string" && value.startsWith("biomarker:")
          ? `result:${value.slice("biomarker:".length)}`
          : value;
      if (next !== value) changed = true;
      if (typeof next === "string") {
        if (seen.has(next)) {
          changed = true;
          continue;
        }
        seen.add(next);
      }
      renamed.push(next);
    }
    if (changed) update.run(JSON.stringify(renamed), row.id);
  }
}

function renameUndoPayloads(db: Database.Database): void {
  if (!tableExists(db, "deleted_rows")) return;
  const rows = db
    .prepare(
      `SELECT id, kind, label, payload
         FROM deleted_rows
        WHERE kind = ? OR payload LIKE ?`
    )
    .all(OLD_UNDO_KIND, `%"kind":"${OLD_UNDO_KIND}"%`) as {
    id: number;
    kind: string;
    label: string | null;
    payload: string;
  }[];
  const update = db.prepare(
    "UPDATE deleted_rows SET kind = ?, label = ?, payload = ? WHERE id = ?"
  );
  for (const row of rows) {
    let payload = row.payload;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { kind?: unknown }).kind === OLD_UNDO_KIND
      ) {
        payload = JSON.stringify({
          ...(parsed as Record<string, unknown>),
          kind: UNDO_KIND,
        });
      }
    } catch {
      // Preserve an already-unreadable payload byte-for-byte. Its kind column and
      // generic label can still leave the retired namespace without inventing data.
    }
    update.run(
      row.kind === OLD_UNDO_KIND ? UNDO_KIND : row.kind,
      row.label === "biomarker record" ? "clinical observation" : row.label,
      payload,
      row.id
    );
  }
}

// Issue #2740 — finish the persisted half of the clinical-result vocabulary audit.
// Genuine analyte/biomarker keys stay; broad import, protocol and undo contracts move
// atomically, and daily aggregate tables say that they hold totals rather than events.
export function up(db: Database.Database): void {
  renameDailyTotal(
    db,
    "food_log",
    "food_daily_totals",
    "idx_food_log_profile",
    "idx_food_daily_totals_profile"
  );
  renameDailyTotal(
    db,
    "protein_log",
    "protein_daily_totals",
    "idx_protein_log_profile",
    "idx_protein_daily_totals_profile"
  );
  renameSubstanceDailyTotals(db);
  renameImportJobType(db);
  renameProtocolOutcomes(db);
  renameUndoPayloads(db);
}

export const migration: Migration = {
  name: "20260814-persisted-vocabulary",
  up,
};
