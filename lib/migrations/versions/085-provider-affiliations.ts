import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 084 (issue #1055): provider ↔ provider AFFILIATION edges — the missing
// individual-clinician ↔ organization link. A JOIN table (not a column on providers)
// because a clinician legitimately practices at several facilities.
//
// GLOBAL, like `providers` itself: an affiliation is a fact about two shared registry
// rows, not about a profile. It carries NO profile_id, so it does NOT join
// lib/owned-tables.ts (the same treatment as `providers`); the profile-scoping test
// derives the owned set from profile_id-bearing tables and never sees this one, and a
// `.prepare` touching only it needs no profile filter. Suggestions are derived
// per-profile at read time (co-occurrence in the acting profile's encounters), but
// the accepted edge / declined decision is a global registry action (admin-gated, the
// identity-card posture).
//
// Both id columns REFERENCE providers(id) with NO ON DELETE — a provider is only ever
// removed inside mergeProviders (the absorb DELETE), which re-keys these edges FIRST
// (row-ops convention). A NULLABLE… wait: they are NOT NULL (an edge needs both ends).
// mergeProviders handles the re-key specially (UPDATE OR IGNORE + dedupe + drop any
// self-edge), so these two columns are the ONE documented exception on the provider
// merge-link reflection test (a plain re-point UPDATE would trip the UNIQUE pair).
//
// `status` folds the suggest-and-accept DECISION into the same row (the
// visit_link_decisions precedent): 'linked' is an accepted affiliation, 'declined' a
// remembered "don't suggest this pair again". UNIQUE(individual_id, organization_id)
// keeps exactly one row per pair whichever state it is in — the suggester excludes a
// pair that already has ANY row. `source` records provenance (manual / suggested /
// import) for display only. CREATE ... IF NOT EXISTS keeps the migrate() replay a
// pure no-op.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_affiliations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      individual_id   INTEGER NOT NULL REFERENCES providers(id),
      organization_id INTEGER NOT NULL REFERENCES providers(id),
      status          TEXT NOT NULL DEFAULT 'linked'
                        CHECK (status IN ('linked','declined')),
      source          TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_affiliations_pair
      ON provider_affiliations(individual_id, organization_id);
    CREATE INDEX IF NOT EXISTS idx_provider_affiliations_org
      ON provider_affiliations(organization_id);
  `);
}

export const migration: Migration = {
  id: 85,
  name: "085-provider-affiliations",
  up,
};
