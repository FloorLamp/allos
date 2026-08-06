import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 163 (issue #2205, phase 1): move the integration sync ledger —
// `integration_sync_events.at` / `.created_at` and `integration_sync_rows.created_at`
// — onto the canonical stored-instant convention, `YYYY-MM-DDTHH:MM:SSZ`.
//
// VALUE-PRESERVING BY CONSTRUCTION. Every one of these values was written by SQLite's
// `datetime('now')`, which renders the UTC wall clock with no zone suffix. They ALREADY
// ARE UTC; the migration only says so out loud. '2026-07-15 20:02:03' and
// '2026-07-15T20:02:03Z' denote the same instant, SQLite's date/time functions parse
// both identically, and rewriting every row of a column in one pass preserves its
// internal ordering exactly (the separator and suffix are constant across the column,
// so the comparison still turns on the digits). Nothing is reinterpreted, no reading
// moves days, and no `date` column is touched — #2205 constraint 1 (value-preserving
// before value-changing) and constraint 4 (`date` semantics untouched).
//
// WHY THIS FAMILY FIRST. `integration_sync_events.at` is the timestamp the issue names:
// it is joined and compared against columns that carry `Z` (metric_samples' instants,
// a caller's ISO cursor), and SQLite compares stored datetimes LEXICALLY, where ' '
// (0x20) sorts before 'T' (0x54). Within one day, every bare value therefore sorts
// before every `Z` value regardless of the actual times — which is how correct-looking
// cross-domain SQL returns a confidently wrong answer.
//
// Two tables are rebuilt rather than UPDATEd in place because the bare shape is also
// their column DEFAULT, and SQLite cannot ALTER a DEFAULT: a rebuild is the only way to
// stop the NEXT insert re-introducing the shape this migration just removed. The
// runner applies migrations with foreign_keys disabled and restores after, so dropping
// the parent doesn't cascade `integration_sync_rows` away; the child is rebuilt in the
// same migration and its FK is re-declared against the rebuilt parent.
//
// SCOPE. Only this family. `profile_share_links.created_at` and the ~95 other bare
// `created_at` columns stay on SQLite's shape for now and keep their bare writers —
// #2205 phases in the conversion one family per migration, and a column is on one
// convention or the other, never mid-flight. lib/__tests__/instant-writer-scan.test.ts
// gains the two tables in the same change as this migration, which is what makes its
// rules A and B enforceable against them.
//
// REPLAY-SAFE. The DB test tier replays migrations over an at-rest database through the
// non-version-gated migrate() wrapper. Guarded on the stored table SQL (the 162/048
// pattern) so a second run is a no-op, and the value rewrite is GLOB-guarded to the
// bare shape so it can only ever fire on an unconverted row.

// The canonical instant, as SQLite renders it — byte-identical to lib/date.ts's
// utcInstant(), which is what every write path binds.
const NOW_Z = `(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;

// 'YYYY-MM-DD HH:MM:SS' exactly — the shape `datetime('now')` writes. GLOB is
// SQLite's case-sensitive wildcard match; a value already carrying 'T'/'Z', or any
// other shape, is left untouched.
const BARE_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]";

// The reinterpretation itself: swap the separator, state the zone.
function toCanonical(column: string): string {
  return `replace(${column}, ' ', 'T') || 'Z'`;
}

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
  // Partial-schema fixtures (migration tests that stop short of 110) may not have the
  // child table yet; the parent has existed since the baseline.
  const hasRows = tableSql(db, "integration_sync_rows") !== "";
  if (tableSql(db, "integration_sync_events").includes("%Y-%m-%dT%H:%M:%SZ"))
    return;

  db.exec(`
    CREATE TABLE integration_sync_events__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      provider TEXT NOT NULL,
      at TEXT NOT NULL,                                 -- UTC instant, 'YYYY-MM-DDTHH:MM:SSZ' (#2205)
      ok INTEGER NOT NULL,
      window_start TEXT,
      window_end TEXT,
      received INTEGER,
      written INTEGER,
      skipped INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW_Z},
      inserted INTEGER,
      updated INTEGER,
      unchanged INTEGER,
      raw_ref TEXT,
      suppressed INTEGER,
      edited INTEGER,
      details TEXT,
      portal_id INTEGER REFERENCES portals(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES portal_accounts(id) ON DELETE SET NULL,
      patient_label TEXT
    );
    INSERT INTO integration_sync_events__new
      (id, profile_id, provider, at, ok, window_start, window_end, received, written,
       skipped, error, created_at, inserted, updated, unchanged, raw_ref, suppressed,
       edited, details, portal_id, account_id, patient_label)
      SELECT id, profile_id, provider,
             CASE WHEN at GLOB '${BARE_GLOB}' THEN ${toCanonical("at")} ELSE at END,
             ok, window_start, window_end, received, written, skipped, error,
             CASE WHEN created_at GLOB '${BARE_GLOB}'
                  THEN ${toCanonical("created_at")} ELSE created_at END,
             inserted, updated, unchanged, raw_ref, suppressed, edited, details,
             portal_id, account_id, patient_label
        FROM integration_sync_events;
    DROP TABLE integration_sync_events;
    ALTER TABLE integration_sync_events__new RENAME TO integration_sync_events;
    CREATE INDEX IF NOT EXISTS idx_sync_events_profile_provider_at
      ON integration_sync_events(profile_id, provider, at);
    CREATE INDEX IF NOT EXISTS idx_sync_events_identity
      ON integration_sync_events(portal_id, account_id, patient_label, at);
  `);

  if (!hasRows) return;

  db.exec(`
    CREATE TABLE integration_sync_rows__new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
      target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs')),
      target_id    INTEGER NOT NULL,
      disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
      created_at   TEXT NOT NULL DEFAULT ${NOW_Z}
    );
    INSERT INTO integration_sync_rows__new
      (id, event_id, target_table, target_id, disposition, created_at)
      SELECT id, event_id, target_table, target_id, disposition,
             CASE WHEN created_at GLOB '${BARE_GLOB}'
                  THEN ${toCanonical("created_at")} ELSE created_at END
        FROM integration_sync_rows;
    DROP TABLE integration_sync_rows;
    ALTER TABLE integration_sync_rows__new RENAME TO integration_sync_rows;
    CREATE INDEX IF NOT EXISTS idx_integration_sync_rows_event
      ON integration_sync_rows(event_id);
  `);
}

export const migration: Migration = {
  id: 163,
  name: "163-sync-ledger-utc-instants",
  up,
};
