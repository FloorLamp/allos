import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { normalizeCanonicalKey } from "../../canonical-name";
import { biomarkerCoverageKey } from "../../coverage-gaps";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "../../dismissal-keys";
import { NON_IDENTITY_CATEGORIES } from "../../medical-categories";

// Issue #2646 — retire the BMI readings ALREADY on disk, now that ingest stops
// writing them.
//
// WHAT CHANGED. `METRIC_DOCUMENT_REACH` has always declared `bmi` reachable, with the
// variant `derived-inputs`: BMI has no row of its own, and `/trends/metric/bmi`
// computes it from the weight and height that arrive in the same document — both of
// which ARE import-projected onto their own charts. That declaration is what removes
// "Body Mass Index" from the flat Biomarkers browser. But `derived-inputs` was the one
// REACHING variant with no ingest consequence: `observations` keeps the row,
// `observation-fold` keeps it, `import-projection` drops it via a `withoutCaptured*`
// helper — and this arm did nothing. So the row survived, an AI import coined an
// `ai` `canonical_biomarkers` name for it, and `getUsedCanonicalNames` returned it
// forever as an outstanding Data → Coverage candidate for a quantity the app answers
// on a chart. `withoutDerivedResults` (lib/import-shape.ts) is the forward arm.
//
// WHY A MIGRATION AS WELL. Migration 180's precedent, and the reasoning is unchanged:
// converging to a DIFFERENT state than the forward path produces would leave two
// sources of truth for the same reading. Forward-only would also leave the Coverage
// candidate exactly where it is on every profile that has ever imported a document,
// which is the surface the issue is about.
//
// A DELETE, NOT A MOVE — and that is the whole difference from 180. There is no
// destination row: nothing in the schema stores a BMI, because the chart is a
// computation. The owner's ruling (#2646 decision 2) is that a stored BMI is never
// independent evidence. Either the visit measured the weight and height, in which case
// the derivation is strictly better (it is recomputed whenever a correction to either
// input lands), or it did not, in which case the printed number is the EHR echoing a
// chart value carried forward — the evidence in the issue is an identical BMI to two
// decimals six days apart, and a FLAT BMI two months later for a growing toddler,
// which for a toddler is not merely uninformative but wrong. So the drop at ingest is
// unconditional, and so is this.
//
// WHICH ROWS. The frozen name vocabulary below — a literal, not a read of the live
// recognizer, the same discipline 180 and 178 follow, so a later release that widens
// `derivedInputsMetricFor` cannot change what this shipped migration did. Note what
// the vocabulary does NOT contain: "Body Mass Index Percentile" and its spellings are
// a DIFFERENT quantity (an age/sex percentile, which the app recomputes from the
// growth curves), and their token sets differ from BMI's, so they are excluded by
// construction rather than by a negative list.
//
// A row a child table still references is SKIPPED, exactly as in 180: an FK parent is
// a bigger claim than this issue makes, and such a row cannot be a BMI in practice. It
// keeps its value and its document. CHILD_LINKS names the three real non-cascading FK
// parents of `medical_records` — the set `lib/__db_tests__/migration-child-links.test.ts`
// pins, and the set 180 got wrong in three of four entries (#2444).
//
// WHAT ELSE TOOK A NAME FROM IT (the AGENTS.md row-ops checklist, as 180 enumerated
// it, and #2646 decision 2 requires unchanged):
//   1. canonical_biomarkers — the ai-coined vocabulary row an AI import minted, which
//      is what put the name under "Uncatalogued items". Only ever `source = 'ai'`; a
//      `seed` row is untouchable (#2306), and the dataset ships none for this name.
//   2. saved_items (kind='biomarker') — the ★ on a name that no longer charts as a
//      biomarker. The quantity is still starrable, under its metric key.
//   3. upcoming_dismissals — the retest snooze `biomarker:<family>` and the
//      flagged-result acknowledgment `biomarker-flag:<family>`.
//   4. coverage_gaps (kind='biomarker') — the tracked catalog gap.
// Each is dropped only when the profile has no identity-carrying `medical_records`
// row left under the name, so a database whose rows were SKIPPED above keeps its
// side-state intact.
//
// Deliberately NOT touched, the #2318/#180 posture: goals.biomarker_name and
// protocols.outcome_keys are USER-AUTHORED, and silently deleting someone's goal is a
// bigger claim than this issue makes. The source documents stay stored, and the weight
// and height rows the same imports captured are untouched — they are the inputs.
//
// NO SCHEMA CHANGE, and no new owned table.
//
// Idempotent: a second run finds no candidate rows and writes nothing.

// The recognizer's vocabulary, FROZEN at this migration's release. Kept in sync with
// the reach registry by review, not by import — see the header.
const BMI_NAME_KEYS = new Set(
  ["BMI", "Body Mass Index", "Body Mass Index (BMI)"].map((n) =>
    normalizeCanonicalKey(n)
  )
);

interface CandidateRow {
  id: number;
  name: string;
  canonical_name: string | null;
}

function isBmiRow(r: CandidateRow): boolean {
  return [r.canonical_name ?? "", r.name].some((n) => {
    const key = normalizeCanonicalKey(n);
    return key !== "" && BMI_NAME_KEYS.has(key);
  });
}

// The non-cascading FK parents of medical_records, as (table, column) pairs. A table
// or column a given database does not have is skipped rather than assumed — the
// migration runs against every historical schema shape — which is exactly why every
// pair here is checked against the FINAL schema by
// lib/__db_tests__/migration-child-links.test.ts: that probe cannot tell a typo from
// an older database, and a misnamed entry is a guard that covers nothing (#2444).
const CHILD_LINKS: readonly { table: string; column: string }[] = [
  { table: "care_plan_items", column: "source_medical_record_id" },
  { table: "care_plan_items", column: "resolved_by_medical_record_id" },
  { table: "intake_items", column: "source_record_id" },
];

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  try {
    return (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
  } catch {
    return false;
  }
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const links = CHILD_LINKS.filter((l) => hasColumn(db, l.table, l.column));
    const referenced = links.map(({ table, column }) =>
      db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`)
    );

    const profiles = (
      db.prepare("SELECT id FROM profiles ORDER BY id").all() as {
        id: number;
      }[]
    ).map((r) => r.id);

    const delRecord = db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND id = ?"
    );
    // Does this profile still carry the name on a row with biomarker identity?
    const identitySql = `category NOT IN (${NON_IDENTITY_CATEGORIES.map(
      () => "?"
    ).join(",")})`;
    const stillNamed = db.prepare(
      `SELECT 1 FROM medical_records
         WHERE profile_id = ?
           AND COALESCE(NULLIF(TRIM(canonical_name), ''), name) = ? COLLATE NOCASE
           AND ${identitySql}
         LIMIT 1`
    );
    const dropSaved = db.prepare(
      `DELETE FROM saved_items
         WHERE profile_id = ? AND kind = 'biomarker' AND key = ? COLLATE NOCASE`
    );
    const dropGap = db.prepare(
      `DELETE FROM coverage_gaps
         WHERE profile_id = ? AND kind = 'biomarker' AND item_key = ? COLLATE NOCASE`
    );
    const dropDismissal = db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
    );

    // The names actually seen on retired rows, per profile — the side-state sweep keys
    // on what the DATA said, never on the one spelling this file happens to name.
    const retiredNames = new Map<number, Set<string>>();

    for (const profileId of profiles) {
      const rows = db
        .prepare(
          `SELECT id, name, canonical_name
             FROM medical_records
            WHERE profile_id = ?
              AND (name LIKE '%body mass index%' OR name LIKE '%bmi%'
                   OR canonical_name LIKE '%body mass index%'
                   OR canonical_name LIKE '%bmi%')
            ORDER BY date, id`
        )
        .all(profileId) as CandidateRow[];

      for (const r of rows) {
        if (!isBmiRow(r)) continue;
        if (referenced.some((stmt) => stmt.get(r.id))) continue;
        delRecord.run(profileId, r.id);
        const label = (r.canonical_name ?? "").trim() || r.name.trim();
        if (!label) continue;
        const set = retiredNames.get(profileId) ?? new Set<string>();
        set.add(label);
        retiredNames.set(profileId, set);
      }
    }

    if (retiredNames.size === 0) return;

    // Side-state sweep, per profile, per name that lost its last identity-carrying row.
    const orphaned = new Set<string>();
    for (const [profileId, names] of retiredNames) {
      for (const name of names) {
        if (stillNamed.get(profileId, name, ...NON_IDENTITY_CATEGORIES))
          continue;
        orphaned.add(name.toLowerCase());
        dropSaved.run(profileId, name);
        dropGap.run(profileId, biomarkerCoverageKey(name));
        dropDismissal.run(profileId, biomarkerDismissalKey(name));
        dropDismissal.run(profileId, biomarkerFlagDismissalKey(name));
      }
    }

    // The vocabulary is a GLOBAL table, so its row goes only when NO profile still
    // backs the name — and only when the row was ai-coined. The one genuinely
    // cross-profile question is answered by UNIONING each profile's own surviving
    // names (the #2318 posture), never by an unscoped read of a profile-owned table.
    if (orphaned.size === 0) return;
    const namesOf = db.prepare(
      `SELECT DISTINCT lower(COALESCE(NULLIF(TRIM(canonical_name), ''), name)) AS n
         FROM medical_records WHERE profile_id = ? AND ${identitySql}`
    );
    const backedSomewhere = new Set<string>();
    for (const profileId of profiles)
      for (const row of namesOf.all(profileId, ...NON_IDENTITY_CATEGORIES) as {
        n: string;
      }[])
        backedSomewhere.add(row.n);
    const dropVocab = db.prepare(
      "DELETE FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE AND source = 'ai'"
    );
    for (const name of orphaned) {
      if (backedSomewhere.has(name)) continue;
      dropVocab.run(name);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  name: "20260813-bmi-derived-rows",
  up,
};
