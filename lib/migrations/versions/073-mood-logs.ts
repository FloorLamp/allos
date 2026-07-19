import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 073 (issue #992): the daily wellbeing check's `mood_logs` table — one
// row per profile per day carrying a 1–5 mood/valence rating plus the optional
// expand-only dimensions (energy, anxiety/calm — also 1–5), optional factor chips
// (a JSON array of slugs, normalized in code by lib/mood.ts so an off-vocabulary
// value can never trip a CHECK), and an optional free-text note.
//
// STORAGE DECISION (argued in #992, per the #860/#944 observation-substrate rule):
// a mood entry is a dated per-subject reading, but it is MULTI-DIMENSIONAL (valence
// + energy + anxiety + factors + note answered together, one row per day) — a shape
// no existing observation store holds without either fanning one check-in across
// three metric_samples rows (breaking the "one entry per day, edited as one" model)
// or overloading symptom_logs' severity vocabulary. #992 product-decided its own
// small table. It deliberately does NOT join the biomarker machinery: mood is never
// reference-range flagged, never retested, never gamified (pinned by
// lib/__tests__/mood-guardrails.test.ts).
//
// The UNIQUE(profile_id, date) index is the idempotency key: every write path (the
// dashboard card's server action, the offline-queue replay, the Telegram check-in
// button) upserts on it, so a replayed or re-tapped check-in updates the day's one
// row instead of duplicating it.
//
// Profile-OWNED: born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`, so it
// joins OWNED_TABLES (lib/owned-tables.ts) — cleared by deleteProfile, covered by
// the profile-scoping leak test. The runner applies migrations with foreign_keys
// OFF and restores it, so the REFERENCES is enforced at runtime.
//
// CREATE ... IF NOT EXISTS + index guards keep the non-version-gated migrate()
// replay a no-op. Determinism (spec): reads only the DB catalog + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mood_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      valence    INTEGER NOT NULL CHECK (valence BETWEEN 1 AND 5),
      energy     INTEGER CHECK (energy BETWEEN 1 AND 5 OR energy IS NULL),
      anxiety    INTEGER CHECK (anxiety BETWEEN 1 AND 5 OR anxiety IS NULL),
      factors    TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mood_logs_day
      ON mood_logs(profile_id, date);
  `);
}

export const migration: Migration = {
  id: 73,
  name: "073-mood-logs",
  up,
};
