// The DB half of #2479 part 2: re-file the `medical_records` rows still stored under
// the legacy `category = 'biomarker'` catch-all into a category that STATES WHAT THEY
// ARE, using the canonical registry's own classification as the evidence.
//
// WHAT THE CATCH-ALL IS. `'biomarker'` predates #1076. It never meant a class of
// clinical thing — it meant "this is a result and nothing narrower was picked", which
// is why `RESULTS_CATALOG_CATEGORIES` excludes it (nothing browsable can be defined by
// the absence of a decision) and why seven SQL sites still read it as a synonym for
// `lab` (`category IN ('lab','biomarker')`). A row filed there is filed nowhere.
//
// THE MAPPING IS NOT A NEW POLICY. It is the rule the AI ingest path has already
// followed since #1076 — "the canonical dataset owns the classification: when the
// resolved canonical name is in the controlled vocabulary, its category WINS over the
// model's guess" (lib/medical-extract/normalize.ts) — applied RETROACTIVELY to the
// rows that predate it. Migration 090 did the same thing by hand for five names
// (PHQ-9 / GAD-7 / AUDIT-C / AUDIT / DAST-10 → 'instrument', Biological Age /
// PhenoAge → 'derived', Glucose → 'lab'); this generalises that pass to the whole
// registry instead of a hand-list, so the answer cannot drift from the vocabulary.
//
// EVIDENCE, AND ONLY EVIDENCE. A candidate row is matched to a
// `canonical_biomarkers` entry on its own identity — `canonical_name` when it has
// one, otherwise the printed `name` — by EXACT (NOCASE) name, the table's own primary
// key collation. No fuzzy snapping, no LOINC inference, no name heuristics: this is a
// one-shot write against data a user cannot review first, and a wrong re-file is
// invisible. A row whose identity is not in the registry, or whose registry entry
// states no category, is left EXACTLY where it is and counted in the report's
// `residue`. Unclassifiable is a real answer here; guessing is not.
//
// IDENTITY IS NEVER REMOVED. Every target below carries result identity
// (`carriesResultIdentity`), so a moved row keeps its `canonical_biomarkers`
// registration, stays in `getUsedCanonicalNames`, and keeps backing its ★, its retest
// and flag dismissals, its coverage entry and its series. That is what makes this
// pass so much smaller than #2318's (lib/assessment-reclass-db.ts): nothing takes a
// NAME away from anything, so there is no side-state sweep to get right. `assessment`
// is excluded from the targets for exactly that reason — moving a row there WOULD
// strip identity, which is a far bigger claim than "this row was filed in the bucket
// that means nothing".
//
// NOTHING IS DELETED, AND NO ID CHANGES. The pass is a single-column UPDATE. The
// #2444 child-link hazard — a one-shot row move that DELETES rows must declare and
// probe the (table, column) links that block a delete — does not arise here by
// construction, not by an argument: `care_plan_items.source_medical_record_id`,
// `care_plan_items.resolved_by_medical_record_id` and `intake_items.source_record_id`
// all reference `medical_records(id)`, and every one of those ids survives this pass
// untouched. There is deliberately no CHILD_LINKS registry in this file; a guard for
// a delete that cannot happen is the kind of guard #2444 is about.
//
// WHAT THE MOVE CHANGES, on purpose:
//   • The flat Results catalog gains the rows whose registry entry says `lab`,
//     `vitals` (per-analyte, #2365), `genomics` or `scan` — legacy readings that were
//     browsable nowhere, only because of the bucket they were filed in.
//   • A row re-filed as `vitals` / `instrument` / `derived` / `reference` stops
//     carrying a lab RETEST clock (`biomarkerRetestStatus`), which the catch-all gave
//     it by falling through. A VO2 Max from a watch is monitored, not redrawn on a
//     yearly cadence — the same reason blood pressure carries no retest nudge.
//   • Nothing else. `name`, `canonical_name`, `value`, `flag`, `loinc`, the document
//     link and the provenance are all untouched.
//
// The `'biomarker'` value stays LEGAL in the `medical_records` CHECK. Dropping it
// would need a table rebuild that can only be safe if this pass is total, and it is
// deliberately not total — the residue above is the point. The value is retired in
// CODE instead (`RETIRED_MEDICAL_CATEGORIES` in lib/medical-categories.ts): no write
// path this build ships can produce it, so the residue can shrink and never grow.
//
// It takes an explicit handle rather than the lib/db singleton because a migration
// runs before that singleton exists, and it assumes the caller has already opened a
// transaction (the runner wraps every up() in an IMMEDIATE one).
//
// Idempotent: a second run finds only the residue, which by definition it cannot
// classify, and writes nothing.

import type Database from "better-sqlite3";
import type { MedicalCategory } from "./types";

/** The legacy catch-all this pass empties. */
export const LEGACY_CATCH_ALL_CATEGORY = "biomarker";

// The categories a registry entry may re-file a row INTO, FROZEN at this migration's
// release — a shipped migration must not change behaviour when a later release grows
// `MEDICAL_CATEGORIES` (the discipline migrations 178 and 180 follow for their own
// vocabularies). `satisfies` keeps it honest against the enum, and the DB test pins
// that each is still legal and still identity-carrying.
//
// Absent on purpose: `biomarker` (the bucket being emptied), `assessment` (would strip
// identity — see the header), `report` (a narrative body, never a registry entry) and
// `prescription` (a medication, never a registry entry).
export const RECLASS_TARGET_CATEGORIES = [
  "lab",
  "vitals",
  "genomics",
  "scan",
  "instrument",
  "derived",
  "reference",
] as const satisfies readonly MedicalCategory[];

export interface LegacyCategoryReclassReport {
  /** Rows moved, keyed by the target category the registry chose. */
  moved: Record<string, number>;
  /**
   * The identities left behind — a row the registry does not classify. Reported
   * rather than guessed, and each keeps its category, its value and its document.
   */
  residue: { identity: string; rows: number }[];
}

interface CandidateRow {
  id: number;
  identity: string;
}

const IDENTITY_SQL = `TRIM(COALESCE(NULLIF(TRIM(canonical_name), ''), name))`;

function profileIds(db: Database.Database): number[] {
  return (
    db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]
  ).map((r) => r.id);
}

/**
 * The registry's classification for every identity it recognises, lower-cased for the
 * NOCASE match the `canonical_biomarkers.name` primary key already uses.
 *
 * Read from the TABLE, not from lib/canonical-biomarkers.json: the migration runs
 * before the boot task that seeds the JSON, so the table is the vocabulary as the
 * database actually has it — data, not this release's code. A database whose
 * vocabulary lacks an entry leaves that row in the residue rather than being
 * classified by a dataset it has never seen.
 */
function registryCategories(db: Database.Database): Map<string, string> {
  const allowed = new Set<string>(RECLASS_TARGET_CATEGORIES);
  const out = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT name, category FROM canonical_biomarkers
        WHERE TRIM(COALESCE(category, '')) != ''`
    )
    .all() as { name: string; category: string }[];
  for (const r of rows) {
    if (!allowed.has(r.category)) continue;
    out.set(r.name.trim().toLowerCase(), r.category);
  }
  return out;
}

function candidates(db: Database.Database, profileId: number): CandidateRow[] {
  return db
    .prepare(
      `SELECT id, ${IDENTITY_SQL} AS identity
         FROM medical_records
        WHERE profile_id = ? AND category = ?
        ORDER BY id`
    )
    .all(profileId, LEGACY_CATCH_ALL_CATEGORY) as CandidateRow[];
}

/**
 * Re-file the legacy catch-all rows the canonical registry can classify.
 *
 * PROFILE SCOPING: every `medical_records` statement filters by `profile_id` and the
 * pass runs per profile, exactly as the #2306 and #2318 passes do. The one global read
 * is `canonical_biomarkers`, which is a global reference table and carries no
 * profile-owned data.
 */
export function reclassifyLegacyBiomarkerCategory(
  db: Database.Database
): LegacyCategoryReclassReport {
  const report: LegacyCategoryReclassReport = { moved: {}, residue: [] };
  const registry = registryCategories(db);
  const move = db.prepare(
    `UPDATE medical_records SET category = ?
      WHERE profile_id = ? AND id = ? AND category = ?`
  );
  const residue = new Map<string, number>();

  for (const profileId of profileIds(db)) {
    for (const row of candidates(db, profileId)) {
      const target = registry.get(row.identity.toLowerCase());
      if (!target) {
        const key = row.identity || "(unnamed)";
        residue.set(key, (residue.get(key) ?? 0) + 1);
        continue;
      }
      const changed = move.run(
        target,
        profileId,
        row.id,
        LEGACY_CATCH_ALL_CATEGORY
      ).changes;
      if (changed > 0) report.moved[target] = (report.moved[target] ?? 0) + 1;
    }
  }

  report.residue = [...residue]
    .map(([identity, rows]) => ({ identity, rows }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return report;
}
