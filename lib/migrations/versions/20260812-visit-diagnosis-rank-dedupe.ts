import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { normalizeVisitDiagnosisSummary } from "../../visit-diagnoses";

// Heal the visit-diagnosis summaries already on disk (issue #2589).
//
// `encounters.diagnoses` is a "; "-joined summary of a visit's diagnosis display names.
// Until the import seam started normalizing them, a source system that bakes the
// diagnosis RANK into the display name produced one finding listed twice:
//
//   "Encounter for genetic carrier testing; Encounter for genetic carrier testing - Primary"
//
// which the Visits card renders as two full-width chips. Re-importing the document heals
// its own encounters, but nobody should have to re-import their history to stop being
// told they were diagnosed with the same thing twice — so this rewrites the stored
// summaries once, through the SAME pure function the import seam and its diff mirror
// call (lib/visit-diagnoses.ts). A second copy of the rule here is how the two drift.
//
// The qualifier list is closed, so a name carrying an ordinary hyphenated clause is
// byte-identical afterwards and its row is never touched.
//
// No CHILD_LINKS declaration: this migration deletes no row and moves no id — it only
// rewrites a text column in place. A delete-guard probe on a pass that cannot delete is
// the #2444 defect, not protection against it. Idempotent: normalizing an
// already-normalized summary returns it unchanged, so re-running writes nothing.
export function up(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, diagnoses FROM encounters
        WHERE diagnoses IS NOT NULL AND TRIM(diagnoses) != ''`
    )
    .all() as { id: number; diagnoses: string }[];
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE encounters SET diagnoses = ? WHERE id = ?`);
  for (const r of rows) {
    const next = normalizeVisitDiagnosisSummary(r.diagnoses);
    if (next !== r.diagnoses) update.run(next, r.id);
  }
}

export const migration: Migration = {
  name: "20260812-visit-diagnosis-rank-dedupe",
  up,
};
