import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 122 (issues #1405, #1406): the medical-passport completeness pass —
// the allergy attributes that decide whether an allergy is a SAFETY signal at all,
// and the immunization attributes every school / travel / camp / employer form asks
// for. Purely additive: new nullable columns plus one child table. Nothing here
// changes an existing value, and every legacy row keeps meaning exactly what it
// meant (see the "unstated is not a default" note below).
//
// ── ALLERGIES (#1405) ─────────────────────────────────────────────────────────
//
//   • `criticality` — FHIR AllergyIntolerance.criticality: the potential for a
//     future exposure to be life-threatening, which is a DIFFERENT question from
//     how bad the recorded reaction was (`severity`). An anaphylaxis-risk penicillin
//     allergy and a nuisance one look identical today, so the emergency card and the
//     passport cannot rank them. Vocabulary pinned to FHIR's three values.
//
//   • `verification_status` — FHIR AllergyIntolerance.verificationStatus. A
//     SUSPECTED penicillin allergy, a CONFIRMED one, and one a challenge test
//     REFUTED are clinically three different facts, and today they are one row that
//     looks the same. This matters beyond display: a refuted allergy must NOT gate
//     a drug (lib/queries/intake/safety.getIntakeSafetyContext), and an
//     entered-in-error row must not appear on the passport at all. Vocabulary pinned
//     to FHIR's four values plus 'suspected' (the word the issue and the UI use for
//     FHIR R5's 'presumed').
//
//   Both are NULLABLE and every existing row stays NULL. "Unstated" is a real third
//   answer and is NOT the same claim as 'confirmed' / 'low' — the lab-lifecycle
//   precedent (migration 120's result_status) settled this: never guess a default
//   for a vocabulary the source never stated. Read sites therefore treat NULL as
//   "not refuted, not known-critical", which is exactly today's behavior.
//
//   • `allergy_reactions` — the graded manifestation list. A peanut allergy that
//     causes BOTH hives and anaphylaxis cannot be stored today: `allergies.reaction`
//     is one scalar, so the second manifestation is lost on import and unenterable
//     by hand.
//
//     WHY A CHILD TABLE AND NOT A JSON COLUMN: the manifestations are queried
//     (the drug-allergy matcher reads them) and are individually graded, so they are
//     rows, not a blob. It carries NO profile_id and reaches one through
//     `allergy_id` → allergies, per the profile-scoping test's child-table
//     convention (exactly like medical_record_revisions → medical_records in 120).
//     It is therefore NOT in OWNED_TABLES: deleteProfile clears it through its
//     parent, and at runtime (foreign_keys = ON) ON DELETE CASCADE clears it
//     whenever the allergy goes away — including the per-document import footprint
//     sweep, which deletes a document's `allergies` rows. It has no document_id and
//     no source of its own for the same reason: it belongs to the allergy, so a
//     document delete and a document reassign both reach it through the row they
//     already move.
//
//     THE CACHED-FIRST-ROW INVARIANT. `allergies.reaction` / `.severity` are NOT
//     retired — ~10 read sites (Timeline, Search, export, the passport, the
//     cross-document representative CTE's dedup identity) select them, and a
//     retracted column would silently change every one of those. They stay as a
//     DENORMALIZED CACHE of the FIRST manifestation, maintained by the one write
//     core (lib/allergy-reactions-write.setAllergyReactions). Reads compose through
//     the ONE pure function lib/allergy-reactions.composeAllergyReactions: child
//     rows when the allergy has any, else the cached scalar as a single implicit
//     manifestation — so an imported row that only ever had the scalar reads
//     identically to a hand-entered one. The backfill below seeds a child row for
//     every existing allergy that has a reaction, so the two shapes agree from the
//     first boot after this migration.
//
// ── IMMUNIZATIONS (#1406) ─────────────────────────────────────────────────────
//
//   • `lot_number` / `site` — free TEXT. A lot number is a manufacturer string and
//     a site is named far more diversely than any enum we could freeze ("left
//     deltoid", "R thigh", "left vastus lateralis"), so both take migration 120's
//     `specimen` treatment: free text, no CHECK.
//
//   • `route` — CHECK-pinned, because unlike a site the route vocabulary really is
//     small and closed in practice. 'other' is a deliberate escape hatch so an
//     unusual route never forces a rebuild migration (growing a CHECK does).
//
//   • `reaction` — free TEXT: the adverse reaction to THIS dose, which had nowhere
//     to live (notes is the dose's general note and is already used for other things).
//
//   • `immunization_overrides.exemption_type` — CHECK-pinned to the three exemption
//     categories school forms actually distinguish. NULL for every existing row and
//     for an 'immune' override, where the concept does not apply; the action only
//     accepts it alongside kind='declined'.
//
// Every step is guarded / IF NOT EXISTS, so a migrate() replay is a pure no-op.

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === col);
}

export function up(db: Database.Database): void {
  // ---- Allergies -----------------------------------------------------------
  if (!hasColumn(db, "allergies", "criticality")) {
    db.exec(
      `ALTER TABLE allergies
         ADD COLUMN criticality TEXT
         CHECK (criticality IS NULL OR criticality IN ('low','high','unable-to-assess'))`
    );
  }
  if (!hasColumn(db, "allergies", "verification_status")) {
    db.exec(
      `ALTER TABLE allergies
         ADD COLUMN verification_status TEXT
         CHECK (verification_status IS NULL OR verification_status IN
                ('unconfirmed','suspected','confirmed','refuted','entered-in-error'))`
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS allergy_reactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      allergy_id    INTEGER NOT NULL REFERENCES allergies(id) ON DELETE CASCADE,
      -- The manifestation as printed / entered ("Hives", "Anaphylaxis").
      manifestation TEXT NOT NULL,
      -- This manifestation's own grade. Free text for the same reason the parent's
      -- severity is: sources print "mild"/"moderate"/"severe" and plenty else.
      severity      TEXT,
      -- Display order; 0 is the manifestation cached onto the parent row.
      position      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_allergy_reactions_allergy
      ON allergy_reactions(allergy_id, position);
  `);
  // One-shot backfill (a data move belongs in a migration, not a boot flag): seed
  // the existing scalar manifestation as row 0 for every allergy that has one.
  // Guarded on "this allergy has no child rows yet" so a replay can't duplicate.
  db.exec(`
    INSERT INTO allergy_reactions (allergy_id, manifestation, severity, position)
    SELECT a.id, TRIM(a.reaction), a.severity, 0
      FROM allergies a
     WHERE a.reaction IS NOT NULL AND TRIM(a.reaction) <> ''
       AND NOT EXISTS (SELECT 1 FROM allergy_reactions r WHERE r.allergy_id = a.id)
  `);

  // ---- Immunizations -------------------------------------------------------
  if (!hasColumn(db, "immunizations", "lot_number")) {
    db.exec(`ALTER TABLE immunizations ADD COLUMN lot_number TEXT`);
  }
  if (!hasColumn(db, "immunizations", "route")) {
    db.exec(
      `ALTER TABLE immunizations
         ADD COLUMN route TEXT
         CHECK (route IS NULL OR route IN
                ('intramuscular','subcutaneous','intradermal','oral','intranasal','other'))`
    );
  }
  if (!hasColumn(db, "immunizations", "site")) {
    db.exec(`ALTER TABLE immunizations ADD COLUMN site TEXT`);
  }
  if (!hasColumn(db, "immunizations", "reaction")) {
    db.exec(`ALTER TABLE immunizations ADD COLUMN reaction TEXT`);
  }
  if (!hasColumn(db, "immunization_overrides", "exemption_type")) {
    db.exec(
      `ALTER TABLE immunization_overrides
         ADD COLUMN exemption_type TEXT
         CHECK (exemption_type IS NULL OR exemption_type IN
                ('medical','religious','philosophical'))`
    );
  }
}

export const migration: Migration = {
  id: 122,
  name: "122-records-safety-passport",
  up,
};
