import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 134 (issue #1777): one nullable `label` column on `import_tombstones`, so a
// content-hash document tombstone can NAME what it is blocking.
//
// ── WHY THERE IS NO NEW TABLE HERE ───────────────────────────────────────────
//
// The re-import tombstone (migration 023, issues #507/#508) is already exactly the right
// substrate: `(profile_id, target_table, natural_key)` with a UNIQUE index, a write on
// delete, a remove on undo, and `suppressed` as a first-class accounting category beside
// it. A deleted DOCUMENT slots straight in as `target_table = 'medical_documents'`,
// `natural_key = <content_hash>` — the content hash is ALREADY the document's identity
// (lib/medical-pipeline/storage.ts::findDedupTarget dedups on it), so no new key had to
// be invented and no second holding table has to be kept consistent with the first.
//
// The ONE asymmetry, documented rather than forced: the existing tombstone entries are
// consulted by the keyed upserts in lib/integrations/normalize.ts (TOMBSTONE_TABLES);
// the document tombstone's consult point is the ACQUIRER INGEST PATH instead. So
// `medical_documents` is deliberately NOT added to TOMBSTONE_TABLES — wedging it in
// would tell every keyed upsert to consult a table it has no business in. The document
// half lives in lib/document-tombstones.ts, reading and writing the same rows.
//
// ── WHY A LABEL COLUMN ───────────────────────────────────────────────────────
//
// Every existing tombstone is invisible: it is consulted by a sync and never rendered,
// so an opaque natural key costs nothing. The document tombstone is the FIRST one a
// person has to read — #1777's "N documents blocked from re-acquisition" list, with an
// Allow-again action per row — and a sha-256 hex digest is not a document. The label
// captures the filename at delete time, which is the only moment allos still knows it:
// the row it came from is dropped in the same transaction.
//
// It is NULLABLE and NOT backfilled. Existing rows (activity / body-metric /
// medical-record tombstones) have no filename and never will; a null reads as "no name
// recorded" and the document list falls back to a hash prefix. Nothing about the old
// entries changes, and nothing consults this column except the document surface.
//
// Pure additive DDL — a single ADD COLUMN guarded on PRAGMA table_info, so a fresh
// database and an already-converged one end identical and a replay is a no-op.
// Determinism (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "import_tombstones").has("label")) {
    db.exec(`ALTER TABLE import_tombstones ADD COLUMN label TEXT;`);
  }
}

export const migration: Migration = {
  id: 134,
  name: "134-tombstone-label",
  up,
};
