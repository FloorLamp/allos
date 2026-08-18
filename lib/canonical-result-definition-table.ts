import type Database from "better-sqlite3";

export type CanonicalResultDefinitionTable =
  "canonical_result_definitions" | "canonical_biomarkers";

/**
 * Frozen migrations 174, 177, 178, and 185 call current shared helpers before the
 * #2737 rename migration runs. Runtime code always receives the current table; the
 * legacy literal exists only so a database can replay that immutable migration chain.
 */
export function canonicalResultDefinitionTableForSchema(
  db: Database.Database
): CanonicalResultDefinitionTable {
  const current = db
    .prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table' AND name = 'canonical_result_definitions'`
    )
    .get();
  return current ? "canonical_result_definitions" : "canonical_biomarkers";
}
