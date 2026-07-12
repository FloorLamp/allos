import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 028 (issue #550): the coverage-gap registry.
//
// When a profile has a biomarker / medication / condition the app's curated
// catalogs don't cover, the app can't provide context (reference range, flag,
// retest cadence, interactions, description) and silently degrades to defaults.
// This table lets a user OPT IN per item to track that gap and fill it — either
// with their own (optionally local/zero-egress) AI generating DESCRIPTIVE context,
// or by filing a de-identified catalog-request to the maintainer. The registry
// persists across app updates so a later catalog update that covers the item can
// be surfaced ("now available").
//
// One directly profile-owned table (born `profile_id INTEGER NOT NULL`, so it is
// added to lib/owned-tables.ts and covered by the profile-scoping test). Its
// identity key is a REUSABLE string (canonical biomarker name / normalized med
// name / condition code-or-name), matching the starred_biomarkers side-store
// shape, so it carries a UNIQUE(profile_id, kind, item_key) rather than only an id.
//
// AI-fill safety boundary (issue #550 decision A): ai_description holds DESCRIPTIVE
// context ONLY. It never carries a reference range, flag threshold, or interaction
// severity — those drive clinical logic and must stay curated. The column is
// labeled "AI-generated, unverified" wherever it surfaces.
//
// Pure additive DDL (CREATE ... IF NOT EXISTS), so a fresh DB and an already-
// converged one both end identical and the non-version-gated migrate() wrapper
// replays it as a no-op. Determinism rule (spec): reads only the DB + its own
// constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coverage_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      -- Which catalog the item is missing from.
      kind TEXT NOT NULL CHECK (kind IN ('biomarker', 'medication', 'condition')),
      -- Stable REUSABLE identity key: for a biomarker the lowercased #482 family
      -- identity / canonical key, for a medication the normalized generic name,
      -- for a condition the ICD-10 code (or lowercased name when uncoded). Matched
      -- against the current curated catalog to decide "now covered".
      item_key TEXT NOT NULL COLLATE NOCASE,
      -- Human display label (the name the user sees).
      label TEXT NOT NULL,
      -- AI-generated DESCRIPTIVE context (never a reference range / threshold /
      -- severity), or NULL. Labeled "AI-generated, unverified" wherever shown.
      ai_description TEXT,
      -- The AI backend host/model that produced ai_description, for the audit/
      -- provenance line (host-only, never a URL that could carry a secret).
      ai_source TEXT,
      ai_generated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, kind, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_coverage_gaps_profile
      ON coverage_gaps(profile_id);
  `);
}

export const migration: Migration = {
  id: 28,
  name: "028-coverage-gaps",
  up,
};
