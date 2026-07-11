import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 020 (issue #389, part 2): index medical_records on
// (profile_id, created_at).
//
// getNewlyFlaggedBiomarkers (lib/notifications/digest-data.ts) reads
//   WHERE profile_id = ? AND created_at > ? AND flag IS NOT NULL AND flag != 'normal'
//   ORDER BY created_at DESC
// on every dashboard render (the attention hero) and once per household profile. The
// existing medical_records indexes key on `date` / `canonical_name`, not `created_at`,
// so this fell back to a profile-wide scan + filesort by created_at. The composite
// (profile_id, created_at) lets the profile filter, the created_at range, and the
// created_at-DESC ordering all be served from the index.
//
// Pure additive DDL — a CREATE INDEX IF NOT EXISTS, so a fresh DB and an
// already-converged one both end identical, and the non-version-gated migrate()
// wrapper replays it as a no-op. Determinism rule (spec): reads only the DB + its own
// constants.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_medical_records_profile_created
       ON medical_records(profile_id, created_at);`
  );
}

export const migration: Migration = {
  id: 20,
  name: "020-medical-records-created-index",
  up,
};
