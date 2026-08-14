import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2737 — the instance-wide canonical registry defines reportable clinical
// results, not only laboratory biomarkers. SQLite's table rename preserves every
// row, column, constraint, index and source value in place; no compatibility view is
// left behind, so all post-migration reads and writes use one physical namespace.
export function up(db: Database.Database): void {
  const alreadyRenamed = db
    .prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table' AND name = 'canonical_result_definitions'`
    )
    .get();
  if (alreadyRenamed) {
    const replayedBaseline = db
      .prepare(
        `SELECT 1
           FROM sqlite_master
          WHERE type = 'table' AND name = 'canonical_biomarkers'`
      )
      .get();
    if (replayedBaseline) {
      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM canonical_biomarkers")
        .get() as { count: number };
      if (count !== 0) {
        throw new Error(
          "Refusing to discard populated canonical_biomarkers after the canonical result registry was already renamed"
        );
      }
      db.exec("DROP TABLE canonical_biomarkers;");
    }
    return;
  }
  db.exec(
    "ALTER TABLE canonical_biomarkers RENAME TO canonical_result_definitions;"
  );
}

export const migration: Migration = {
  name: "20260814-canonical-result-definitions",
  up,
};
