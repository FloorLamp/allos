import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 130 (issue #1748): ACQUIRED-BY provenance — which portal a document was
// pushed in from.
//
// Migration 128 gave allos the portal vocabulary and the `(portal, patient-label) →
// profile` binding, and the upload route resolves against it. But that resolution was
// AMNESIAC: it computed a profile id from `(portal, patient)` and then discarded the
// identity, so nothing on the resulting document recorded how it arrived.
//
// That is fine with one portal and no CLI use. It stops being fine the moment a household
// maps two portals for two providers, or mixes portal pushes with the plain human CLI
// path. Two portals' exports are never byte-identical — exports are not byte-stable even
// within one portal — so file-level dedup does not collapse them: the same profile synced
// from two providers yields two documents whose EXTRACTED RECORDS overlap. When those two
// copies disagree about an immunization, "which copy came from where" needs an answer,
// and "was this pushed by the tool or dropped in by hand" needs one too.
//
// A NULLABLE column, populated ONLY on the portal-resolved path. NULL is not "unknown" —
// it is the positive statement "a human put this here", which is exactly what every
// pre-existing row and every future CLI/browser/share-sheet upload means. So there is no
// backfill: every existing document genuinely has no portal acquisition, and the column
// reads correctly on day one.
//
// It names the PORTAL, not the patient label. The label is a routing input — it already
// did its job by selecting a profile, it is re-derivable from the binding, and storing a
// second copy of a person's portal-spelled name on every document row would be one more
// place for it to drift from the binding that owns it. The portal is the acquisition fact
// worth keeping.
//
// FK ON DELETE SET NULL: provenance points AT the registry entry, so a portal that leaves
// the vocabulary takes with it the ability to name it. lib/portals.ts::deletePortal also
// nulls these links explicitly, so the teardown holds with foreign_keys off — the same
// posture its portal_identities cleanup already uses. SQLite permits a REFERENCES clause
// on ADD COLUMN precisely because the default is NULL.
//
// A COLUMN ON AN EXISTING TABLE, not a new one: `medical_documents` is already
// profile-owned, already in OWNED_TABLES, already in every import-cleanup, reassignment,
// and extracted-count list. Adding a column to it adds no new footprint table, so no
// registry needs updating. (Reassignment deliberately CARRIES this column across: how a
// document arrived is a fact about its arrival, not about whose profile it now belongs
// to — see the note in the reassign path.)
//
// House rules (CLAUDE.md): one guarded ADD COLUMN, no rebuild, so there is nothing to
// null beforehand. Self-contained — imports nothing from lib/ — so a replay is decided
// purely by the DB catalog and this file's own constants. Determinism (spec): reads only
// the DB catalog.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "medical_documents").has("acquired_portal_id")) {
    db.exec(
      `ALTER TABLE medical_documents ADD COLUMN acquired_portal_id INTEGER
         REFERENCES portals(id) ON DELETE SET NULL`
    );
  }
  // The card and the detail page both read "which portal did this come from", and the
  // portal-delete cleanup reads the inverse. One index on the link covers both, and it is
  // sparse in practice (NULL for every hand-uploaded document).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_medical_documents_acquired_portal
       ON medical_documents(acquired_portal_id)`
  );
}

export const migration: Migration = {
  id: 130,
  name: "130-acquirer-provenance",
  up,
};
