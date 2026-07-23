import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 103 — bare-abbreviation → "Full Name (ABBR)" canonical-name consolidation.
//
// 15 measured-lab canonical biomarker entries whose name was a bare acronym were
// renamed to the spelled-out "Full Name (ABBR)" form (e.g. "RDW" → "Red Cell
// Distribution Width (RDW)") so the passport biomarker list reads consistently.
// The dataset (canonical-biomarkers.json), the LOINC map, the derivers, the
// families/curated tables, and new CANONICAL_ALIASES were all updated in the same
// change — so FRESH imports snap the acronym onto the new name. This migration
// closes the loop for ALREADY-STORED rows: their `canonical_name` still holds the
// old bare acronym, and the flag-reconcile + biological-age derivers look the
// canonical entry up by EXACT name (cbByName.get(canonical_name)) — so without this
// rewrite an existing "RDW" row would no longer match its (renamed) entry and would
// lose its reference band, and PhenoAge would stop finding its MCV/RDW/hs-CRP inputs.
//
// Rewrites the two tables that key on the biomarker's canonical name:
//   • medical_records.canonical_name — the stored readings (bands, series, derivers)
//   • starred_biomarkers.canonical_name — the passport pins
// Both are per-profile but the rename is a pure value substitution (the same analyte
// keeps its identity), so a single UNCONDITIONAL UPDATE per (table, old→new) is
// correct and profile-agnostic — every row of the old name, whatever its profile,
// becomes the new name.
//
// NOTE ON STARS: starred_biomarkers has PRIMARY KEY (profile_id, canonical_name). If a
// profile somehow already pinned BOTH the old acronym AND the new name (impossible
// before this rename shipped, but belt-and-suspenders for a re-run), the UPDATE to a
// colliding key would throw — so the star rewrite is UPDATE OR IGNORE (keep the
// existing new-name pin, drop the redundant old one).
//
// Self-contained (manifest freeze — never imports lib/): the rename map is inlined.
// Replay-safe (the non-version-gated migrate() wrapper replays up() unconditionally):
// after the first run no row carries an old bare acronym, so every UPDATE no-ops.
// COLLATE NOCASE on the match so a case-variant stored spelling is caught too.

const RENAMES: [string, string][] = [
  ["ApoB", "Apolipoprotein B (ApoB)"],
  ["hs-CRP", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
  ["GGT", "Gamma-Glutamyl Transferase (GGT)"],
  ["ALT", "Alanine Aminotransferase (ALT)"],
  ["AST", "Aspartate Aminotransferase (AST)"],
  ["BUN", "Blood Urea Nitrogen (BUN)"],
  ["MCV", "Mean Corpuscular Volume (MCV)"],
  ["RDW", "Red Cell Distribution Width (RDW)"],
  ["TIBC", "Total Iron-Binding Capacity (TIBC)"],
  ["TSH", "Thyroid-Stimulating Hormone (TSH)"],
  ["IGF-1", "Insulin-Like Growth Factor 1 (IGF-1)"],
  ["PSA", "Prostate-Specific Antigen (PSA)"],
  ["MCH", "Mean Corpuscular Hemoglobin (MCH)"],
  ["MCHC", "Mean Corpuscular Hemoglobin Concentration (MCHC)"],
  ["MPV", "Mean Platelet Volume (MPV)"],
];

export function up(db: Database.Database): void {
  const rec = db.prepare(
    `UPDATE medical_records SET canonical_name = ?
      WHERE canonical_name = ? COLLATE NOCASE`
  );
  const star = db.prepare(
    `UPDATE OR IGNORE starred_biomarkers SET canonical_name = ?
      WHERE canonical_name = ? COLLATE NOCASE`
  );
  const run = db.transaction(() => {
    for (const [oldName, newName] of RENAMES) {
      rec.run(newName, oldName);
      star.run(newName, oldName);
      // A star row that collided (both names pinned) is left as the old row after
      // OR IGNORE; delete the now-redundant old-name pin so it doesn't linger.
      db.prepare(
        `DELETE FROM starred_biomarkers WHERE canonical_name = ? COLLATE NOCASE`
      ).run(oldName);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 103,
  name: "103-canonical-name-abbreviation-consolidation",
  up,
};
