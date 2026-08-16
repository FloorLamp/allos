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
// 2. `medical_documents.acquired_identity_id` — the missing half of the acquisition
//    fact. #1748's `acquired_portal_id` names the PORTAL a document arrived from, which
//    is the right fact for "Acquired via optum" but far too coarse to correlate a
//    delivery with the run that delivered it. The documents and the report arrive on two
//    different requests (POST /api/documents, then POST /api/documents/sync-report) and
//    nothing correlated them.
//
//    THE GRAIN IS THE PATIENT IDENTITY, not the portal and not the login, because that
//    is the grain the tool REPORTS at: one push under one login files a separate report
//    per patient (`patient=` names it), and both endpoints name the same
//    (login, patient label) pair. Recording anything coarser leaves a run claiming
//    another patient's archives — and, when a wall clock is used to separate them, leaves
//    the second patient's documents claimed by nobody at all. `portal_identities.id` is
//    exactly that pair (migration 131: a patient label is unique per LOGIN), so the claim
//    is a plain equality with no clock in it.
//
//    Nullable, populated only on the portal-resolved upload path, and NULL keeps meaning
//    exactly what `acquired_portal_id`'s NULL means — "a human put this here". No
//    backfill: a document uploaded before this column existed genuinely has no recorded
//    identity, and inventing one from its portal would be a guess in the one place this
//    feature refuses to guess.
//
//    FK ON DELETE SET NULL, matching #1748's posture: provenance points AT the registry
//    row, so an identity that leaves the vocabulary takes with it the ability to name it.
//    lib/portals.ts nulls the link explicitly too, so teardown holds with foreign_keys
//    off. SQLite permits a REFERENCES clause on ADD COLUMN because the default is NULL.
//
// 3. `medical_documents.delivered_at` — WHEN a portal run claimed this archive, and the
//    reason the claim is not asked of `integration_sync_rows`.
//
//    A run claims only documents NO RUN HAS CLAIMED YET, so the guard needs a durable
//    memory of the attribution. The provenance row is not one: it is a CHILD of
//    integration_sync_events with `ON DELETE CASCADE`, and #388's retention sweep
//    (SYNC_EVENTS_RETENTION_DAYS = 90, run on the hourly tick) deletes those events. The
//    rows go with them, the guard forgets, and every archive older than the window
//    becomes claimable again — so an ordinary run that delivered nothing would claim a
//    year of history and render it as today's delivery. That cascade is exactly right for
//    the five RECORD tables, which are claimed at write time by the upsert that wrote
//    them; it is wrong for a table whose claim state IS the guard.
//
//    So the attribution lives on the DOCUMENT, which is what it is a fact about, and
//    outlives every run that ever reported it. The provenance row stays what it always
//    was — the run's own listing of what it delivered, expiring with the run.
//
// Replay-safe on every half: the rebuild is gated on the converged CHECK already
// containing the sentinel, the ADD COLUMN on the catalog, the indexes on IF NOT EXISTS.
// Self-contained — imports nothing from lib/ — so a replay is decided purely by the DB
// catalog.
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

  const documents = columnNames(db, "medical_documents");
  if (!documents.has("acquired_identity_id")) {
    db.exec(
      `ALTER TABLE medical_documents ADD COLUMN acquired_identity_id INTEGER
         REFERENCES portal_identities(id) ON DELETE SET NULL`
    );
  }
  if (!documents.has("delivered_at")) {
    db.exec(`ALTER TABLE medical_documents ADD COLUMN delivered_at TEXT`);
  }
  // Both reads this feature makes, in one index. The claim asks "which of this identity's
  // archives has no run claimed yet" (identity, then `delivered_at IS NULL`); the login
  // row asks "what did this identity deliver, and when" (identity, then the delivered
  // instants). Sparse in practice — NULL identity for every hand-uploaded document.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_medical_documents_acquired_identity
       ON medical_documents(acquired_identity_id, delivered_at)`
  );
}

export const migration: Migration = {
  name: "20260816-document-sync-provenance",
  up,
};
