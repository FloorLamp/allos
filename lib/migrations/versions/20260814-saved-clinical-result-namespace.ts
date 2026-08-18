import type Database from "better-sqlite3";
import type { Migration } from "../runner";

interface SavedRow {
  id: number;
  profile_id: number;
  kind: string;
  key: string;
  position: number | null;
  created_at: string;
  backed: number;
}

interface MergedSavedRow extends SavedRow {
  sourceKind: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

function noCaseKey(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function mergePosition(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

// Retire the saved-store and Trends-series `biomarker` vocabulary. This is a clean
// break: the rebuilt CHECK admits only `clinical-result`, and runtime series keys use
// `result:`. The historical migration that folded `bio:` pins remains frozen; this
// forward migration carries its output into the current namespace.
export function up(db: Database.Database): void {
  if (!tableExists(db, "saved_items")) return;

  const rows = db
    .prepare(
      `SELECT id, profile_id, kind, key, position, created_at, backed
         FROM saved_items
        ORDER BY id`
    )
    .all() as SavedRow[];

  const merged = new Map<string, MergedSavedRow>();
  for (const row of rows) {
    if (
      row.kind !== "biomarker" &&
      row.kind !== "clinical-result" &&
      row.kind !== "trend-metric"
    ) {
      throw new Error(
        `unsupported saved_items kind during namespace migration: ${row.kind}`
      );
    }
    const kind = row.kind === "biomarker" ? "clinical-result" : row.kind;
    const identity = `${row.profile_id}\0${kind}\0${noCaseKey(row.key)}`;
    const prior = merged.get(identity);
    if (!prior) {
      merged.set(identity, { ...row, kind, sourceKind: row.kind });
      continue;
    }

    prior.id = Math.min(prior.id, row.id);
    prior.position = mergePosition(prior.position, row.position);
    prior.backed = Math.max(prior.backed, row.backed);
    if (row.created_at < prior.created_at) prior.created_at = row.created_at;

    // A mixed-version fixture may contain both names. Prefer the already-current
    // row's spelling while merging the old row's order/backing history into it.
    if (prior.sourceKind === "biomarker" && row.kind === "clinical-result") {
      prior.key = row.key;
      prior.sourceKind = row.kind;
    }
  }

  db.exec(`
    CREATE TABLE saved_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      kind TEXT NOT NULL CHECK (kind IN ('clinical-result','trend-metric')),
      key TEXT NOT NULL COLLATE NOCASE,
      position INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      backed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(profile_id, kind, key)
    );
  `);
  const insert = db.prepare(
    `INSERT INTO saved_items_new
       (id, profile_id, kind, key, position, created_at, backed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of merged.values()) {
    insert.run(
      row.id,
      row.profile_id,
      row.kind,
      row.key,
      row.position,
      row.created_at,
      row.backed
    );
  }
  db.exec(`
    DROP TABLE saved_items;
    ALTER TABLE saved_items_new RENAME TO saved_items;
    CREATE INDEX idx_saved_items_profile_kind
      ON saved_items(profile_id, kind);
  `);

  if (tableExists(db, "upcoming_dismissals")) {
    db.exec(`
      UPDATE OR IGNORE upcoming_dismissals
         SET signal_key = 'digest:result:' || substr(signal_key, length('digest:bio:') + 1)
       WHERE signal_key LIKE 'digest:bio:%';
      DELETE FROM upcoming_dismissals
       WHERE signal_key LIKE 'digest:bio:%';
    `);
  }
}

export const migration: Migration = {
  name: "20260814-saved-clinical-result-namespace",
  up,
};
