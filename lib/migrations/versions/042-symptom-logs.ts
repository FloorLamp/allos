import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 042 (issue #799): the symptom log + the situations `illness_type` flag.
//
// symptom_logs — the standalone, day-by-day EXPERIENTIAL layer the medical passport
// lacked (the closest prior entity, medication side effects, was bolted to a med). One
// profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)` so it
// joins OWNED_TABLES (lib/owned-tables.ts) — that single edit propagates to deleteProfile
// and the profile-scoping leak test. UNIQUE(profile_id, date, symptom) makes a
// symptom-day ONE row; the write path keeps the day's WORST (highest) severity on a re-tap
// (a tap only RAISES; an explicit edit may lower). `symptom` is a STABLE key — a curated
// slug from lib/symptoms.json OR a normalized custom name (the #203 discipline: a rename
// is display-only / a custom rename re-keys its rows, never re-slugs a curated one).
//
// illness_type on situations — the id-keyed situations vocabulary (#560) gains a flag so
// the symptom card and the DERIVED episode association key ONLY on flagged situations
// (Travel/High-stress never become symptom containers). The built-in "Illness" defaults
// ON; user situations opt in via the situations-bar toggle. Added as a NOT NULL DEFAULT 0
// column, then backfilled to 1 for any existing "Illness" row.
//
// CREATE ... IF NOT EXISTS + the column/index guards keep the non-version-gated migrate()
// replay a no-op. Determinism: reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symptom_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      symptom    TEXT NOT NULL,
      severity   INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 4),
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, date, symptom)
    );
    CREATE INDEX IF NOT EXISTS idx_symptom_logs_profile
      ON symptom_logs(profile_id, date DESC);
  `);

  if (!columnNames(db, "situations").has("illness_type")) {
    db.exec(
      `ALTER TABLE situations
         ADD COLUMN illness_type INTEGER NOT NULL DEFAULT 0
         CHECK (illness_type IN (0, 1));`
    );
  }

  // The built-in "Illness" situation is the canonical symptom container — default its
  // flag ON for any existing row (a no-op on a fresh DB with none).
  db.prepare(
    `UPDATE situations SET illness_type = 1 WHERE name = 'Illness' COLLATE NOCASE`
  ).run();
}

export const migration: Migration = {
  id: 42,
  name: "042-symptom-logs",
  up,
};
