import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { reclassifyLegacyBiomarkerCategory } from "../../legacy-category-reclass-db";

// Migration 185 (issue #2479 part 2): retire the persisted `medical_records.category
// = 'biomarker'` catch-all by re-filing the rows the canonical registry can classify
// into the category that states what they are.
//
// WHY A MIGRATION. The same change closes every path that WRITES the catch-all — the
// extraction prompt's "use `biomarker` when nothing else fits" and its tool enum, the
// three VO₂ Max writers (Health Connect, Withings, the fitness battery), the manual
// category picker, the seed — but forward-only would leave every existing database
// with rows filed in a bucket that means "no decision was made": invisible to the flat
// Results catalog, carrying a lab retest clock they never earned, and read as `lab` by
// seven SQL sites that had to special-case them. So the one-shot data move belongs
// here (AGENTS.md: "Put one-shot data moves in a migration, not a settings flag"),
// the shape migrations 174, 177 and 180 all take.
//
// NO SCHEMA CHANGE — this is an UPDATE of one column, and `'biomarker'` stays legal in
// the CHECK. Emptying the bucket completely would need a table rebuild, and a rebuild
// is only honest if the pass is TOTAL. It deliberately is not: a row whose identity
// the registry does not classify stays exactly where it is and is reported rather than
// guessed at (see lib/legacy-category-reclass-db.ts). The value is retired in CODE
// instead — `RETIRED_MEDICAL_CATEGORIES` keeps it out of every assignable set — so the
// residue can only shrink from here.
//
// NOTHING IS DELETED AND NO ID MOVES, so the #2444 child-link hazard cannot arise:
// `care_plan_items.source_medical_record_id`,
// `care_plan_items.resolved_by_medical_record_id` and `intake_items.source_record_id`
// all keep pointing at the same rows. There is no CHILD_LINKS registry in this
// migration on purpose — a probe guarding a delete that cannot happen is precisely the
// guard-that-covers-nothing #2444 is about.
//
// NO BOOT TASK. Unlike #2306's alias merge, nothing here can drift between two boots:
// the vocabulary's `category` field only changes when the committed dataset changes,
// and by then no write path can produce a new catch-all row for it to re-file. A row
// that stays in the residue stays visible, on its document and under the category
// filter, until a human decides what it is.
//
// Profile-scoped: the pass runs per profile and every `medical_records` statement
// filters by `profile_id` (the global read is `canonical_biomarkers`, a reference
// table). Idempotent: a second run finds only the residue and writes nothing.

export function up(db: Database.Database): void {
  // The runner already wraps up() in an IMMEDIATE transaction; the migrate() test
  // wrapper calls up() in autocommit, so this nests as a SAVEPOINT there and is the
  // transaction here.
  const run = db.transaction(() => {
    reclassifyLegacyBiomarkerCategory(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 185,
  name: "185-legacy-biomarker-category",
  up,
};
