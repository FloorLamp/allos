import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 077 (issue #1036): one-shot transposition of ALREADY-STORED optical
// prescriptions written in PLUS-cylinder (ophthalmology) notation onto the app's
// canonical MINUS-cylinder (optometry) convention.
//
// The same refraction is written two ways, and they transpose exactly:
// "−2.00 −1.00 ×180" ≡ "−3.00 +1.00 ×090" — the SPHERE differs by the full
// cylinder amount between the notations. Before this fix nothing normalized, so a
// plus-cyl Rx (from an ophthalmologist / an imported record) sat next to its
// minus-cyl equivalent uncompared, and the Vision page's sphere-over-time trend
// read a convention switch as fake myopia progression. New writes are canonical
// at every boundary (the shared parseEyeRefraction coercion — manual form, AI
// extractor, FHIR VisionPrescription mapper); this migration converges the rows
// written before that existed, healing the trend for imported histories.
//
// The transposition, per eye, only where the stored cylinder is POSITIVE:
//   sphere′ = sphere + cyl   (NULL sphere stays NULL — sphere + cyl is unknowable)
//   axis′   = (axis + 90) mod 180, with 0 ⇒ 180 (the 1–180 axis convention;
//             NULL axis stays NULL — the sphere is what the trend reads)
//   cyl′    = −cyl
// Pure algebra, no data loss (the original is recoverable by the inverse), and no
// interpretation change — the slip's refraction is preserved exactly, in one
// convention. Minus-cylinder and cylinder-less rows are untouched byte-for-byte.
//
// Self-contained by design (the manifest freezes this file): the algebra is
// inlined in SQL rather than imported, so later refactors of lib/ can never
// change what this shipped migration did. REPLAY SAFETY (the non-version-gated
// migrate() wrapper): the UPDATEs only touch rows with a positive cylinder, and
// after the first run none remain (every write path now stores minus-cyl), so a
// second run is a pure no-op. Deliberately profile-AGNOSTIC: a vocabulary-level
// notation converge across all profiles — each UPDATE rewrites a row's own
// columns from that same row, never reading across rows or profiles.
// Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  // Partial-handle guard (mirrors migration 074): a hand-built test DB may lack
  // the table entirely. db.pragma reads schema metadata, never rows.
  const cols = db.pragma("table_info(optical_prescriptions)") as {
    name: string;
  }[];
  if (cols.length === 0) return;

  // SQLite evaluates every SET expression against the PRE-update row, so the
  // sphere/axis expressions read the original cylinder even though it is also
  // being negated in the same statement.
  db.exec(`
    UPDATE optical_prescriptions SET
      od_sphere   = CASE WHEN od_sphere IS NULL THEN NULL
                         ELSE ROUND(od_sphere + od_cylinder, 2) END,
      od_axis     = CASE WHEN od_axis IS NULL THEN NULL
                         WHEN ((od_axis + 90) % 180) = 0 THEN 180
                         ELSE (od_axis + 90) % 180 END,
      od_cylinder = ROUND(-od_cylinder, 2)
    WHERE od_cylinder > 0;

    UPDATE optical_prescriptions SET
      os_sphere   = CASE WHEN os_sphere IS NULL THEN NULL
                         ELSE ROUND(os_sphere + os_cylinder, 2) END,
      os_axis     = CASE WHEN os_axis IS NULL THEN NULL
                         WHEN ((os_axis + 90) % 180) = 0 THEN 180
                         ELSE (os_axis + 90) % 180 END,
      os_cylinder = ROUND(-os_cylinder, 2)
    WHERE os_cylinder > 0;
  `);
}

export const migration: Migration = {
  id: 77,
  name: "077-optical-minus-cylinder",
  up,
};
