import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 069 (issue #715): the structured SKIN-LESION record type — the skin
// enabler (#707 Phase 1) that supplies the final adapter for the finding →
// follow-up → resolution chain (#700, core shipped in migration 050). Mirrors the
// dental record type (#705, migration 067) and the imaging-study type (#702,
// migration 037).
//
// STORAGE DECISION (argued in the PR, per the #860/#944 observation-substrate rule):
//   • A lesion carries an IDENTITY (a specific mole at a body-map location) with
//     ABCDE observations + status that NO existing store holds — so this ONE net-new
//     table `skin_lesions` holds it. Each row is a DATED observation; serial
//     observations of the SAME lesion share the identity (normalized body_region +
//     body_side + label, lib/skin-lesion.ts), so a later record RESOLVES the
//     follow-up (the dental "later record on the same tooth" analogue).
//   • SERIAL PHOTOS reuse the medical-uploads POSTURE (per-profile dirs, sha256
//     dedup, profile-scoped serving) but their OWN table `lesion_photos` + files dir
//     (data/uploads/lesion-photos/<profileId>/) — the symptom_photos precedent
//     (migration 049) — bound to a lesion by lesion_id, NOT a parallel copy of the
//     medical-document pipeline.
//
// Both tables are profile-OWNED, born `profile_id INTEGER NOT NULL REFERENCES
// profiles(id)`, so they join OWNED_TABLES (lib/owned-tables.ts). skin_lesions.
// `document_id` carries a real REFERENCES FK to medical_documents (nullable, no ON
// DELETE) so it can join the import footprint by document_id like the other record
// types; `provider_id` carries a real REFERENCES FK into the global providers
// registry (nullable, no ON DELETE). lesion_photos.`lesion_id` carries a real
// REFERENCES FK to skin_lesions (NOT NULL, no ON DELETE) — a photo belongs to a
// lesion; deleting a lesion clears its photos FIRST (the app path), and the profile
// sweep runs with foreign_keys OFF. The runner applies migrations with foreign_keys
// OFF and restores it, so every stored REFERENCES is enforced at runtime.
//
// The skin_lesions `status` CHECK is the low-cardinality classifier gating the
// follow-up loop: 'watch' seeds a recheck, 'active' is tracked, 'removed' is history.
// The five ABCDE columns are USER-RECORDED OBSERVATIONS stored as 0/1 (#715 scope: no
// malignancy score). body_region / body_side / status are normalized in code
// (lib/skin-lesion.ts) so an off-vocabulary value can never trip a CHECK.
//
// This migration ALSO extends the care_plan_items follow-up chain (#700) with the
// SKIN adapter's two nullable link columns — source_skin_lesion_id (the lesion that
// motivated a recheck) and resolved_by_skin_lesion_id (the later lesion record the
// resolution was recorded against) — exactly as migration 050 added the imaging
// links, 060 the medical_records links, and 067 the dental links. SQLite permits a
// REFERENCES clause on a BRAND-NEW nullable column (default NULL), so no
// create→copy→drop→rename dance is needed.
//
// CREATE ... IF NOT EXISTS + the index guards + the ADD COLUMN presence checks keep
// the non-version-gated migrate() replay a no-op. Determinism (spec): reads only the
// DB catalog + its own constants.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skin_lesions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      label         TEXT,
      body_region   TEXT,
      body_side     TEXT CHECK (
                      body_side IN ('left', 'right', 'midline')
                      OR body_side IS NULL
                    ),
      size_mm       REAL,
      asymmetry     INTEGER NOT NULL DEFAULT 0 CHECK (asymmetry IN (0, 1)),
      border        INTEGER NOT NULL DEFAULT 0 CHECK (border IN (0, 1)),
      color         INTEGER NOT NULL DEFAULT 0 CHECK (color IN (0, 1)),
      diameter      INTEGER NOT NULL DEFAULT 0 CHECK (diameter IN (0, 1)),
      evolving      INTEGER NOT NULL DEFAULT 0 CHECK (evolving IN (0, 1)),
      status        TEXT NOT NULL DEFAULT 'active' CHECK (
                      status IN ('active', 'watch', 'removed')
                    ),
      observed_date TEXT,
      finding       TEXT,
      follow_up_interval_days INTEGER,
      provider_id   INTEGER REFERENCES providers(id),
      notes         TEXT,
      source        TEXT,
      document_id   INTEGER REFERENCES medical_documents(id),
      external_id   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skin_lesions_profile
      ON skin_lesions(profile_id, observed_date);
    CREATE INDEX IF NOT EXISTS idx_skin_lesions_document
      ON skin_lesions(document_id);
    CREATE INDEX IF NOT EXISTS idx_skin_lesions_status
      ON skin_lesions(profile_id, status);

    CREATE TABLE IF NOT EXISTS lesion_photos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      lesion_id    INTEGER NOT NULL REFERENCES skin_lesions(id),
      date         TEXT NOT NULL,
      stored_path  TEXT NOT NULL,
      content_hash TEXT,
      mime_type    TEXT,
      size_bytes   INTEGER,
      caption      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lesion_photos_lesion
      ON lesion_photos(profile_id, lesion_id, date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lesion_photos_dedup
      ON lesion_photos(profile_id, content_hash)
      WHERE content_hash IS NOT NULL;
  `);

  // Extend the care_plan_items follow-up chain with the skin adapter's links (mirrors
  // migration 050's imaging links / 060's medical_records links / 067's dental links).
  // Guarded behind column-presence checks so the non-version-gated migrate() replay is
  // a no-op; production applies each ADD COLUMN exactly once behind the version gate.
  const cols = new Set(columnNames(db, "care_plan_items"));
  if (cols.size > 0) {
    if (!cols.has("source_skin_lesion_id")) {
      db.exec(
        `ALTER TABLE care_plan_items
           ADD COLUMN source_skin_lesion_id INTEGER REFERENCES skin_lesions(id);`
      );
    }
    if (!cols.has("resolved_by_skin_lesion_id")) {
      db.exec(
        `ALTER TABLE care_plan_items
           ADD COLUMN resolved_by_skin_lesion_id INTEGER REFERENCES skin_lesions(id);`
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_care_plan_items_source_skin
         ON care_plan_items(source_skin_lesion_id)
         WHERE source_skin_lesion_id IS NOT NULL;`
    );
  }
}

export const migration: Migration = {
  id: 69,
  name: "069-skin-lesions",
  up,
};
