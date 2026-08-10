import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { applyCanonicalRename } from "../../canonical-alias-merge-db";

// Migration 178 — re-point every reading and every piece of name-keyed state onto the
// canonical spellings #2335 renamed.
//
// WHAT CHANGED IN THE DATASET. Twenty curated entries were renamed so that no
// canonical name's meaning depends on an unstated default:
//
//   • The CBC differential held BOTH conventions at once — bare "Neutrophils" was the
//     percentage while bare "Monocytes" was the cell count — so within one panel a
//     bare name meant opposite things. Every member now states its measure, including
//     the one that felt like the default.
//   • The two eye analytes sat beside per-eye siblings with nothing saying which eye
//     they were; each now says the eye is unspecified (which is also what their LOINC,
//     56844-4 "of Eye (unspecified)", names).
//   • The remaining opaque bare abbreviations took the "Long Name (ABBR)" form the
//     other 23 entries already use.
//
// Bare-means-SERUM is untouched on purpose: "Albumin"/"Creatinine"/"Magnesium"/
// "Folate" beside their ", Urine" / ", RBC" siblings carry a universal convention and
// no ambiguity. The rule is written down beside CANONICAL_ALIASES and enforced by
// lib/__tests__/canonical-naming-rule.test.ts.
//
// WHY A MIGRATION. The dataset half is forward-only: seedCanonicalBiomarkers UPSERTs
// the new names on the next boot and every fresh import snaps onto them. What that
// does NOT do is move the readings already stored under the old spelling, and it does
// not remove the old canonical_biomarkers rows either — the seeder has no delete pass,
// so a retired seed row would sit in the vocabulary forever, WINNING its own key and
// blocking the very CANONICAL_ALIASES route added to rescue it (the #2306 defect,
// which only ever retires `ai` rows). Both are one-shot data moves, so they belong
// here (AGENTS.md), with a version, a transaction and a replay test.
//
// The per-profile carry is NOT re-implemented: applyCanonicalRename is #2306's, and it
// owns the enumerated list of everything a canonical name is keyed by — the readings,
// the ★ pin, the retest snooze and flag acknowledgment, a biomarker goal, the coverage
// gap, and the protocols' `biomarker:<name>` outcome links. A rename that skipped one
// of those is a silent orphan, not a cosmetic miss.
//
// FLAGS. `name` is a FLAG_RELEVANT_FIELD, so canonicalFlagsSignature() moves on its
// own and the boot reconcile that follows re-derives every record once — which is what
// the re-pointed rows need, since they are now judged under a different entry name.
// FLAG_LOGIC_VERSION is deliberately NOT bumped: no range, unit or direction changed.
//
// Idempotent: a second run finds no row under an old name and writes nothing.

// The renames, frozen. A migration is immutable, so this table is a literal rather
// than a read of the live dataset — a later rename gets its own migration.
const RENAMES: readonly { from: string; to: string }[] = [
  // The differential, on both axes: no bare member survives.
  { from: "Neutrophils", to: "Neutrophils, Relative" },
  { from: "Lymphocytes", to: "Lymphocytes, Relative" },
  { from: "Monocytes", to: "Monocytes, Absolute" },
  { from: "Eosinophils", to: "Eosinophils, Absolute" },
  { from: "Basophils", to: "Basophils, Absolute" },
  { from: "Immature Granulocytes", to: "Immature Granulocytes, Relative" },
  {
    from: "Nucleated Red Blood Cells",
    to: "Nucleated Red Blood Cells, Relative",
  },
  { from: "Reticulocytes", to: "Reticulocytes, Relative" },
  // The eye pair.
  { from: "Intraocular Pressure", to: "Intraocular Pressure, Unspecified Eye" },
  { from: "Visual Acuity", to: "Visual Acuity, Unspecified Eye" },
  // The opaque abbreviations.
  { from: "Free T4", to: "Thyroxine, Free (Free T4)" },
  { from: "Free T3", to: "Triiodothyronine, Free (Free T3)" },
  { from: "Total T4", to: "Thyroxine, Total (Total T4)" },
  { from: "Total T3", to: "Triiodothyronine, Total (Total T3)" },
  { from: "FEV1", to: "Forced Expiratory Volume in 1 Second (FEV1)" },
  { from: "FVC", to: "Forced Vital Capacity (FVC)" },
  { from: "eGFR", to: "Estimated Glomerular Filtration Rate (eGFR)" },
  { from: "RPR", to: "Rapid Plasma Reagin (RPR)" },
  {
    from: "HOMA-IR",
    to: "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
  },
  {
    from: "ANA Screen, IFA",
    to: "Antinuclear Antibody Screen, Indirect Immunofluorescence Assay (ANA IFA)",
  },
];

export function up(db: Database.Database): void {
  // The vocabulary is global; everything else is profile-owned, so the carry runs per
  // profile and every statement inside it filters by profile_id.
  const profiles = db.prepare("SELECT id FROM profiles ORDER BY id").all() as {
    id: number;
  }[];
  for (const rename of RENAMES) {
    for (const { id } of profiles) applyCanonicalRename(db, id, rename);
    // Retire the old vocabulary row. Deliberately unconditional on `source`: unlike
    // #2306 (where only an `ai` row may be superseded, because a curated row is the
    // authority) the retired name here IS the curated one the dataset just dropped, so
    // leaving it would keep a name the catalog no longer publishes — and block the
    // alias route that now points at its replacement. seedCanonicalBiomarkers inserts
    // the surviving name from the JSON in the boot that follows.
    db.prepare(
      "DELETE FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE"
    ).run(rename.from);
  }
}

export const migration: Migration = {
  id: 178,
  name: "178-canonical-name-qualifiers",
  up,
};
