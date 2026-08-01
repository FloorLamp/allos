import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 136 (issue #1780): the CLINICAL identity of a health-record document — the
// digest of the source-minted entry ids it carries.
//
// Document dedup keys on the content hash of the uploaded bytes, and one person reachable
// through TWO portal logins defeats it by construction: the portal regenerates its export
// container on every request, so two collections of the identical visit list differ byte
// for byte while every clinical XML document inside is byte-identical. Both upload as
// `stored`, both extract, and the profile ends up with every encounter attested twice.
//
// The identifier that already matches is the entry id: every deterministically imported
// row carries `external_id = 'document:<id>|ccda:encounter:354198588'`, and the same visit
// exported through two different logins carries the same trailing id. This column stores
// a digest of a document's whole (sorted, de-duplicated, kind-prefixed) id set, so the
// ingest path can ask "do we already hold these records" as the same cheap indexed
// lookup `content_hash` already gets. lib/clinical-content-key.ts owns the shape and the
// reasoning; this file owns the column, its index, and the one-shot backfill.
//
// A COLUMN ON AN EXISTING TABLE, not a new one: `medical_documents` is already
// profile-owned, already in OWNED_TABLES, and already in every import-cleanup,
// reassignment and extracted-count list, so no registry needs updating. Reassignment
// carries it across profiles on purpose — the clinical key is a fact about the
// document's CONTENT, and the dedup lookup is `(profile_id, clinical_key)`, so a moved
// document starts deduping for its new owner and stops for its old one, which is right.
//
// ── THE BACKFILL, AND WHY IT IS SAFE ─────────────────────────────────────────
//
// Without it the column would be NULL for every document that already exists, so a THIRD
// collection would not be recognised against the two archives already imported — the fix
// would only work on instances with no history. The ids are recoverable exactly where the
// issue says they are: in the `external_id` values of the rows each document already
// wrote. This reads them back, strips the `document:<id>|` namespace, and stores the same
// digest a fresh parse would produce.
//
// The recovered set can only ever be a SUBSET of what a fresh parse yields (a row the
// insert guards dropped leaves no id behind), never a superset. So the worst case is a
// backfilled key that fails to match a later offer — the pre-#1780 behaviour, unchanged —
// and never a key that matches a document it should not. A dedup decision DISCARDS an
// offer, so the error direction matters more than the coverage.
//
// Nothing is deleted here. Documents that already imported twice keep both copies and
// both sets of rows: collapsing them would mean choosing which attestation to destroy,
// and that is a product decision this migration has no business making silently.
//
// House rules (CLAUDE.md): one guarded ADD COLUMN, no table rebuild, so there is nothing
// to null beforehand. Self-contained — imports nothing from lib/ — so a replay is decided
// purely by the DB catalog and this file's own constants. Determinism (spec): reads only
// the database.

// Fewest distinct entry ids a document must carry before its id set stands for its
// clinical identity. MUST match CLINICAL_KEY_MIN_IDS in lib/clinical-content-key.ts —
// duplicated rather than imported because a shipped migration is frozen and may not
// change behaviour when a lib constant later does.
const MIN_IDS = 3;

// Table → the kind prefix its ids are recorded under. MUST match KEYED_ENTITIES in
// lib/clinical-content-key.ts, and duplicated for the same reason as MIN_IDS. Only the
// import-footprint tables that carry an `external_id` appear; body metrics and the
// height/head-circumference samples carry none.
const KEYED_TABLES: readonly { table: string; prefix: string }[] = [
  { table: "medical_records", prefix: "rec" },
  { table: "immunizations", prefix: "imm" },
  { table: "allergies", prefix: "alg" },
  { table: "conditions", prefix: "cnd" },
  { table: "encounters", prefix: "enc" },
  { table: "procedures", prefix: "prc" },
  { table: "family_history", prefix: "fhx" },
  { table: "care_plan_items", prefix: "cpi" },
  { table: "care_goals", prefix: "cgl" },
  { table: "genomic_variants", prefix: "gen" },
  { table: "imaging_studies", prefix: "img" },
  { table: "optical_prescriptions", prefix: "opt" },
  { table: "dental_procedures", prefix: "dnt" },
  { table: "appointments", prefix: "apt" },
];

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

// The `document:<id>|<raw>` namespace import-persist stamps onto a parsed external_id.
// Anything that does not carry it was not written by a document import (or predates the
// namespace) and contributes nothing.
const SCOPED = /^document:(\d+)\|(.+)$/;

export function up(db: Database.Database): void {
  if (!columnNames(db, "medical_documents").has("clinical_key")) {
    db.exec(`ALTER TABLE medical_documents ADD COLUMN clinical_key TEXT`);
  }
  // The dedup probe asks "does THIS profile already hold a document with this clinical
  // key", so the index leads with profile_id — the same shape the content-hash probe
  // gets from idx_meddoc_hash plus its profile filter. Sparse in practice: NULL for
  // every AI-extracted document (its rows carry no external_id).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_meddoc_clinical_key
       ON medical_documents(profile_id, clinical_key)`
  );

  // ── Backfill ────────────────────────────────────────────────────────────────
  //
  // Keyed on (profile_id, document id) and never on the document id alone: each imported
  // row already carries its owner, so grouping by both keeps the write profile-scoped
  // like every other statement in the codebase — and a row whose owner disagrees with the
  // document simply contributes to a group that will not match any document, rather than
  // silently folding one profile's ids into another's key.
  const idsByDoc = new Map<string, Set<string>>();
  const groupKey = (profileId: number, docId: number) => `${profileId}:${docId}`;
  for (const { table, prefix } of KEYED_TABLES) {
    if (!tableExists(db, table)) continue;
    const cols = columnNames(db, table);
    if (!cols.has("external_id") || !cols.has("profile_id")) continue;
    const rows = db
      .prepare(
        `SELECT profile_id AS pid, external_id AS ext FROM ${table}
          WHERE external_id IS NOT NULL AND external_id LIKE 'document:%'`
      )
      .all() as { pid: number; ext: string }[];
    for (const { pid, ext } of rows) {
      const m = SCOPED.exec(ext);
      if (!m) continue;
      const key = groupKey(pid, Number(m[1]));
      let set = idsByDoc.get(key);
      if (!set) {
        set = new Set<string>();
        idsByDoc.set(key, set);
      }
      set.add(`${prefix}:${m[2]}`);
    }
  }

  const update = db.prepare(
    `UPDATE medical_documents SET clinical_key = ?
      WHERE id = ? AND profile_id = ? AND clinical_key IS NULL`
  );
  // Sorted group order so a replay against the same data does the same writes in the same
  // sequence — the runner's determinism expectation.
  for (const key of [...idsByDoc.keys()].sort()) {
    const ids = [...idsByDoc.get(key)!].sort();
    if (ids.length < MIN_IDS) continue;
    const [pid, docId] = key.split(":").map(Number);
    update.run(
      crypto.createHash("sha256").update(ids.join("\n")).digest("hex"),
      docId,
      pid
    );
  }
}

export const migration: Migration = {
  id: 136,
  name: "136-clinical-content-key",
  up,
};
