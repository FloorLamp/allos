import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 085 (issue #1051, historical rows — the DETERMINISM LINE): one-shot,
// append-only backfill of intake_items.provider_id from the free-text `prescriber`
// scrape, for the EXACT, UNAMBIGUOUS, INDIVIDUAL matches only. Runs exactly once by
// version (no settings flag), reads only the DB.
//
// What it links (all must hold):
//   - a medication (kind='medication') whose provider_id IS NULL (an org-occupied
//     link is NEVER clobbered — the semantics decision (a): provider_id is the
//     prescriber INDIVIDUAL link, so a med already pointing at an org/other stays),
//   - with a non-blank `prescriber` text that
//   - matches EXACTLY ONE providers row of type 'individual' (case-insensitive,
//     ends-trimmed) — the same "exact normalized-name" rule the write-time resolver
//     uses.
//
// What it deliberately LEAVES for the #1045 suggest-and-accept flow (never a silent
// link/retype):
//   - a name matching only an ORGANIZATION-typed row with no individual twin (the
//     picker-org-default trap — "is this a person? [Fix type & link]"),
//   - an AMBIGUOUS name (2+ individual rows share it — a near-miss to disambiguate),
//   - a name that fuzzy-matches an individual but isn't exact (a near-miss).
//
// The count guard `= 1` on individual-type rows makes org-only (count 0) and
// ambiguous (count ≥ 2) names fall out of the WHERE; the correlated subquery then
// only ever resolves the single individual. Determinism: no name normalization
// beyond TRIM + NOCASE (internal-whitespace-differing names are near-misses, handled
// by suggest-and-accept), so the result is a pure function of the current rows.
export function up(db: Database.Database): void {
  db.exec(`
    UPDATE intake_items
       SET provider_id = (
             SELECT p.id FROM providers p
              WHERE p.type = 'individual'
                AND p.name = TRIM(intake_items.prescriber) COLLATE NOCASE
           )
     WHERE kind = 'medication'
       AND provider_id IS NULL
       AND prescriber IS NOT NULL
       AND TRIM(prescriber) <> ''
       AND (
             SELECT COUNT(*) FROM providers p
              WHERE p.type = 'individual'
                AND p.name = TRIM(intake_items.prescriber) COLLATE NOCASE
           ) = 1
  `);
}

export const migration: Migration = {
  id: 88,
  name: "088-backfill-prescriber-links",
  up,
};
