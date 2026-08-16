import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2999: a portal run delivers DOCUMENTS, and a document was not a provenance
// target.
//
// The Imports feed promised "What this wrote — 2 records" on every portal run and then
// rewrote itself to "0 records" the moment the drill-in loaded, because
// `integration_sync_rows` had no row it could possibly hold: `target_table` is a closed
// discriminator over the five RECORD tables, and a portal run's product is an archive,
// not a record. The run could record nothing by construction, so the list was always
// empty and the count always fell to zero — the reading #1991 called worse than an empty
// state, because it looks like the import lost something.
//
// TWO CHANGES, and the second is what makes the first reachable.
//
// 1. `medical_documents` joins the provenance vocabulary. Same rebuild shape as
//    migration 119, which admitted `practice_logs`: `target_table` is pinned by a CHECK,
//    so growing it needs SQLite's create → copy → drop → rename rather than an in-place
//    ALTER. Existing rows are copied byte-for-byte, ids and timestamps included. The
//    table is a CHILD of integration_sync_events; the runner disables foreign-key
//    enforcement around rebuild migrations and restores it once the preserved event ids
//    are back.
//
// 2. `medical_documents.acquired_account_id` — the missing half of the acquisition fact.
//    #1748's `acquired_portal_id` names the PORTAL a document arrived from, which is the
//    right fact for "Acquired via optum" but too coarse to correlate a delivery with the
//    run that delivered it: a portal with two logins has two run reports and one portal
//    id. The documents and the report arrive on two different requests
//    (POST /api/documents, then POST /api/documents/sync-report) and nothing correlated
//    them; the LOGIN is what both name, so recording it is what lets the report handler
//    claim exactly the documents its own run pushed.
//
//    Nullable, populated only on the portal-resolved upload path, and NULL keeps meaning
//    exactly what `acquired_portal_id`'s NULL means — "a human put this here". No
//    backfill: a document uploaded before this column existed genuinely has no recorded
//    login, and inventing one from its portal would be a guess in the one place this
//    feature refuses to guess.
//
//    FK ON DELETE SET NULL, matching #1748's posture: provenance points AT the registry
//    row, so a login that leaves the vocabulary takes with it the ability to name it.
//    lib/portals.ts nulls the link explicitly too, so teardown holds with foreign_keys
//    off. SQLite permits a REFERENCES clause on ADD COLUMN because the default is NULL.
//
// Replay-safe on both halves: the rebuild is gated on the converged CHECK already
// containing the sentinel, the ADD COLUMN on the catalog. Self-contained — imports
// nothing from lib/ — so a replay is decided purely by the DB catalog.
const SENTINEL = "'medical_documents'";

// The canonical stored-instant DEFAULT migration 163 moved this column onto (#2205).
// A rebuild re-declares the whole table, so copying migration 119's DDL verbatim would
// silently walk `created_at` back to SQLite's bare `datetime('now')` shape — which the
// temporal-column index catches, and which would then be written by the next insert.
const NOW_Z = `(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;

function tableSql(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'integration_sync_rows'`
    )
    .get() as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const sql = tableSql(db);
  if (sql !== null && !sql.includes(SENTINEL)) {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE integration_sync_rows__new2999 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
          target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs','medical_documents')),
          target_id    INTEGER NOT NULL,
          disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
          created_at   TEXT NOT NULL DEFAULT ${NOW_Z}
        );

        INSERT INTO integration_sync_rows__new2999
          (id, event_id, target_table, target_id, disposition, created_at)
          SELECT id, event_id, target_table, target_id, disposition, created_at
            FROM integration_sync_rows;

        DROP TABLE integration_sync_rows;
        ALTER TABLE integration_sync_rows__new2999 RENAME TO integration_sync_rows;

        CREATE INDEX idx_integration_sync_rows_event
          ON integration_sync_rows(event_id);
      `);
    });
    rebuild.immediate();
  }

  if (!columnNames(db, "medical_documents").has("acquired_account_id")) {
    db.exec(
      `ALTER TABLE medical_documents ADD COLUMN acquired_account_id INTEGER
         REFERENCES portal_accounts(id) ON DELETE SET NULL`
    );
  }
  // The report handler reads "which documents did this login just deliver" on every run,
  // and the login-delete cleanup reads the inverse. One index covers both, and it is
  // sparse in practice (NULL for every hand-uploaded document).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_medical_documents_acquired_account
       ON medical_documents(acquired_account_id)`
  );
}

export const migration: Migration = {
  name: "20260816-document-sync-provenance",
  up,
};
