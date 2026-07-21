import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 084 (issues #1051 + #1052): the durable accept/decline store for the two
// medication-link suggest-and-accept flows, mirroring visit_link_decisions (#1050):
//
//   - kind 'prescriber' (#1051): a near-miss / org-mistype prescriber suggestion
//     ("3 meds say 'S. Chen' — link to Sarah Chen, MD?"), surfaced as a #1045
//     data-quality gap. An ACCEPT sets intake_items.provider_id; a DECLINE is
//     remembered so the gap detector stops re-proposing it.
//   - kind 'indication' (#1052): a tier-2 text-match indication suggestion
//     ("this note says 'ear infection' — link the Otitis media condition?"). An
//     ACCEPT sets intake_items.indication_condition_id; a DECLINE is remembered so
//     the read-time suggester stops re-proposing it.
//
// Both sides are keyed by a STABLE identity token: the medication's `id:<n>` (meds
// carry no external_id — they dedup on document_id + source, the visit-links
// precedent) and the target provider/condition's `id:<n>`. A manual med / manual
// target has a stable id; an imported target re-derives its structural link on
// reprocess (tier-1), so a churned imported-med id at most re-offers the tier-2
// suggestion — never a wrong silent link. NEW profile-OWNED table (joins
// OWNED_TABLES); NOT an import-footprint table (written by the accept/decline
// actions, not the document import — the visit_link_decisions posture). CREATE ...
// IF NOT EXISTS keeps the migrate() replay a pure no-op.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS med_link_decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      -- 'prescriber' (#1051, target = a providers row) |
      -- 'indication' (#1052, target = a conditions row).
      kind         TEXT NOT NULL CHECK (kind IN ('prescriber','indication')),
      -- The medication's STABLE identity token ('id:<n>').
      subject_key  TEXT NOT NULL,
      -- The target row's STABLE identity token ('id:<n>').
      target_key   TEXT NOT NULL,
      decision     TEXT NOT NULL CHECK (decision IN ('linked','declined')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_med_link_decisions_key
      ON med_link_decisions(profile_id, kind, subject_key, target_key);
  `);
}

export const migration: Migration = {
  id: 87,
  name: "087-medication-link-decisions",
  up,
};
