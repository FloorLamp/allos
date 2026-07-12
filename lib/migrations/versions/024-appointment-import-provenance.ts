import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 024 (issue #416): import-provenance columns on appointments — as a
// TABLE REBUILD, because the link column carries a real FK.
//
// The appointments table had a full model (provider link, status lifecycle, kind,
// Upcoming surface) but NO import path could populate it — a FHIR/SHC Appointment
// resource was dropped because the bundle importer had no mapper, and CDA has no
// appointment section. Adding the FHIR Appointment mapper means imported rows must
// trace back to their source document exactly like the other clinical domains, so
// the import-footprint contract (clearImportedDocumentRows / moveImportedDocumentRows
// / countImportedDocumentRows) can delete/reassign/count them.
//
// So appointments gains the encounters-style import-provenance triple:
//   - document_id INTEGER REFERENCES medical_documents(id) — the footprint key
//     (appointments joins the footprint as a document_id-keyed table). Per the
//     house rule converged by migration 006 (issue #95), every nullable link
//     column carries a REAL FK on ALL DB populations — and SQLite can't attach a
//     FK to an existing column, so this is a create→copy→drop→rename REBUILD, not
//     an ADD COLUMN.
//   - source TEXT — the document source string ("document:<id>"), plain text (no
//     FK), matching encounters.
//   - external_id TEXT — the source's stable dedup key ("fhir:appointment:<id>"),
//     plain text, unique per profile via the partial index below so the persist
//     core's INSERT OR IGNORE dedups within a document exactly like encounters.
// All three are nullable: a manually-created appointment leaves them NULL and is
// therefore never touched by a document delete/reassign — the same manual-vs-import
// separation every other domain keeps.
//
// The CREATE below is the version-23 appointments shape VERBATIM — the 001-baseline
// definition (whose provider_id FK matches 006's converged shape) plus 007's `kind`
// column in append position — extended only by the three new trailing columns. The
// copy preserves ids; the one existing index (idx_appointments_profile) is
// recreated, plus the new external-id dedup index.
//
// FK/CASCADE SAFETY: the runner (and the migrate() test wrapper) apply every
// migration with foreign_keys DISABLED and restore it afterward (issue #95), so the
// DROP/RENAME swap is safe; appointments has no FK children. DATA SAFETY: before
// the FK'd copy, any dangling provider_id is nulled (a broken pointer becomes
// "unlinked", never a commit failure); document_id is brand-new, so it has nothing
// to dangle.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays every up()
// unconditionally, so the rebuild is guarded — skipped once the appointments table
// already has a document_id column. Production applies it exactly once behind the
// user_version gate. Determinism: reads only the DB + its own constants.

const CREATE_APPOINTMENTS = `
  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    scheduled_at TEXT NOT NULL,
    provider_id INTEGER REFERENCES providers(id),
    title TEXT,
    location TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT,
    document_id INTEGER REFERENCES medical_documents(id),
    source TEXT,
    external_id TEXT
  );`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_appointments_profile
     ON appointments(profile_id, scheduled_at);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_external
     ON appointments(profile_id, external_id) WHERE external_id IS NOT NULL;`,
];

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  // Replay guard: already rebuilt (or somehow absent) → no-op.
  const oldCols = columnNames(db, "appointments");
  if (oldCols.length === 0 || oldCols.includes("document_id")) return;

  const run = db.transaction(() => {
    // Null any dangling provider_id before the FK'd copy (mirrors 006's rule).
    db.exec(
      `UPDATE appointments SET provider_id = NULL
         WHERE provider_id IS NOT NULL
           AND provider_id NOT IN (SELECT id FROM providers);`
    );

    const scratch = "appointments__new024";
    db.exec(
      CREATE_APPOINTMENTS.replace(
        "CREATE TABLE appointments (",
        `CREATE TABLE ${scratch} (`
      )
    );

    // Copy by the intersection of old/new columns, preserving ids. The new
    // provenance columns aren't in the old table, so they start NULL (manual-like).
    const copyCols = columnNames(db, scratch).filter((c) =>
      oldCols.includes(c)
    );
    const colList = copyCols.join(", ");
    db.exec(
      `INSERT INTO ${scratch} (${colList}) SELECT ${colList} FROM appointments;`
    );

    // DROP first (freeing the old index name), then rename the scratch into place.
    db.exec(`DROP TABLE appointments;`);
    db.exec(`ALTER TABLE ${scratch} RENAME TO appointments;`);

    for (const idx of INDEXES) db.exec(idx);
  });
  // One (possibly nested) transaction: the runner already wraps up() in an
  // IMMEDIATE transaction (this nests as a SAVEPOINT); the migrate() test wrapper
  // calls up() in autocommit (this becomes the transaction).
  run.immediate();
}

export const migration: Migration = {
  id: 24,
  name: "024-appointment-import-provenance",
  up,
};
