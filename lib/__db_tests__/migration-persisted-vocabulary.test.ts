// DB INTEGRATION TIER — #2740's forward rename of durable compatibility names.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260814-persisted-vocabulary";

describe("persisted vocabulary migration", () => {
  it("preserves daily totals and rewrites broad durable namespaces", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY);
      INSERT INTO profiles (id) VALUES (1);

      CREATE TABLE food_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        group_key TEXT NOT NULL,
        servings REAL NOT NULL DEFAULT 0 CHECK (servings >= 0),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (profile_id, date, group_key)
      );
      CREATE INDEX idx_food_log_profile ON food_log(profile_id, date DESC);
      INSERT INTO food_log
        (id, profile_id, date, group_key, servings, notes, created_at)
      VALUES (4, 1, '2026-08-01', 'leafy_greens', 2.5, 'with lunch',
              '2026-08-01 12:00:00');

      CREATE TABLE protein_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        grams REAL NOT NULL DEFAULT 0 CHECK (grams >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (profile_id, date)
      );
      CREATE INDEX idx_protein_log_profile ON protein_log(profile_id, date DESC);
      INSERT INTO protein_log (id, profile_id, date, grams, created_at)
      VALUES (8, 1, '2026-08-01', 35, '2026-08-01 13:00:00');

      CREATE TABLE substance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        substance TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
        logged_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        edited INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        UNIQUE (profile_id, date, substance)
      );
      CREATE INDEX idx_substance_log_profile
        ON substance_log(profile_id, date DESC);
      INSERT INTO substance_log
        (id, profile_id, date, substance, units, logged_at, created_at, source,
         edited, notes)
      VALUES (12, 1, '2026-08-01', 'nicotine', 3,
              '2026-08-01T14:00:00Z', '2026-08-01 14:00:00', 'user', 1,
              'synthetic fixture');

      CREATE TABLE import_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        type TEXT NOT NULL CHECK (type IN ('workouts','biomarkers')),
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
      CREATE INDEX idx_import_jobs_created ON import_jobs(created_at);
      INSERT INTO import_jobs
        (id, profile_id, type, status, source_text, result_json, summary, model,
         created_at, updated_at)
      VALUES (20, 1, 'biomarkers', 'ready', 'LDL,120',
              '{"type":"biomarkers","records":[{"name":"LDL"}]}',
              'one row', 'fixture-model', '2026-08-01 15:00:00',
              '2026-08-01 15:01:00');

      CREATE TABLE protocols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        name TEXT NOT NULL,
        outcome_keys TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO protocols (id, profile_id, name, outcome_keys)
      VALUES (30, 1, 'Synthetic protocol',
              '["biomarker:ApoB","result:ApoB","body:weight"]');

      CREATE TABLE deleted_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        kind TEXT NOT NULL,
        label TEXT,
        payload TEXT NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO deleted_rows (id, profile_id, kind, label, payload, deleted_at)
      VALUES (40, 1, 'biomarker-record', 'biomarker record',
              '{"kind":"biomarker-record","rows":[{"table":"medical_records","id":7}]}',
              '2026-08-01 16:00:00');
    `);

    up(db);

    expect(
      db
        .prepare(
          `SELECT id, profile_id, date, group_key, servings, notes, created_at
             FROM food_daily_totals`
        )
        .get()
    ).toEqual({
      id: 4,
      profile_id: 1,
      date: "2026-08-01",
      group_key: "leafy_greens",
      servings: 2.5,
      notes: "with lunch",
      created_at: "2026-08-01 12:00:00",
    });
    expect(
      db.prepare("SELECT * FROM protein_daily_totals").get()
    ).toMatchObject({ id: 8, profile_id: 1, date: "2026-08-01", grams: 35 });
    expect(
      db
        .prepare(
          `SELECT id, profile_id, date, substance, units, logged_at, created_at,
                  source, edited, notes
             FROM substance_daily_totals`
        )
        .get()
    ).toEqual({
      id: 12,
      profile_id: 1,
      date: "2026-08-01",
      substance: "nicotine",
      units: 3,
      logged_at: "2026-08-01T14:00:00Z",
      created_at: "2026-08-01 14:00:00",
      source: "manual",
      edited: 1,
      notes: "synthetic fixture",
    });

    db.prepare(
      `INSERT INTO substance_daily_totals
         (profile_id, date, substance, units)
       VALUES (1, '2026-08-02', 'cannabis', 1)`
    ).run();
    expect(
      db
        .prepare(
          `SELECT id, source FROM substance_daily_totals
            WHERE substance = 'cannabis'`
        )
        .get()
    ).toEqual({ id: 13, source: "manual" });

    expect(
      db
        .prepare(
          `SELECT id, type, status, source_text, result_json, summary, model,
                  created_at, updated_at
             FROM import_jobs`
        )
        .get()
    ).toEqual({
      id: 20,
      type: "clinical-results",
      status: "ready",
      source_text: "LDL,120",
      result_json: '{"type":"clinical-results","records":[{"name":"LDL"}]}',
      summary: "one row",
      model: "fixture-model",
      created_at: "2026-08-01 15:00:00",
      updated_at: "2026-08-01 15:01:00",
    });
    expect(
      db.prepare("SELECT outcome_keys FROM protocols WHERE id = 30").get()
    ).toEqual({ outcome_keys: '["result:ApoB","body:weight"]' });
    expect(
      db
        .prepare("SELECT kind, label, payload FROM deleted_rows WHERE id = 40")
        .get()
    ).toEqual({
      kind: "clinical-observation",
      label: "clinical observation",
      payload:
        '{"kind":"clinical-observation","rows":[{"table":"medical_records","id":7}]}',
    });

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND (name LIKE '%_log' OR name LIKE '%_daily_totals')
            ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: "food_daily_totals" },
      { name: "protein_daily_totals" },
      { name: "substance_daily_totals" },
    ]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO import_jobs (profile_id, type) VALUES (1, 'biomarkers')"
        )
        .run()
    ).toThrow();

    db.close();
  });
});
