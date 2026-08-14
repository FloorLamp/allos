import type Database from "better-sqlite3";

export type SavedClinicalResultKind = "clinical-result" | "biomarker";

/**
 * Frozen migrations 174, 177, and 178 call current shared helpers before the
 * #2738 saved namespace migration runs. Runtime code always receives the current
 * table; the legacy literal exists only while replaying that immutable migration
 * chain against its historical schema.
 */
export function savedClinicalResultKindForSchema(
  db: Database.Database
): SavedClinicalResultKind {
  const row = db
    .prepare(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'table' AND name = 'saved_items'`
    )
    .get() as { sql: string } | undefined;
  return row?.sql.includes("'clinical-result'")
    ? "clinical-result"
    : "biomarker";
}
