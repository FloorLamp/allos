import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { normalizeCanonicalKey } from "../../canonical-name";
import { biomarkerCoverageKey } from "../../coverage-gaps";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "../../dismissal-keys";
import { NON_IDENTITY_CATEGORIES } from "../../medical-categories";

// Migration 180 (issue #2322) — re-point the waist-circumference readings ALREADY on
// disk onto the metric the same change gave them.
//
// WHAT CHANGED. The owner ruled `Waist Circumference` a BODY METRIC: it is now the
// `waist-circ` slug with a tile, a chart, a `/trends/metric/waist-circ` detail page
// and a ★, charted from `metric_samples` under 'waist_circumference_cm' — and it is
// deliberately NOT a curated biomarker entry, because a body metric imported as a
// biomarker is the `Body Mass Index (BMI)` mistake #2318 spent an issue undoing.
// Ingest follows the ruling forward: lib/waist-circ-extract.ts recognizes the reading
// and lib/import-shape.ts projects it into `metric_samples`, dropping the
// `medical_records` row exactly as the height and head-circumference arms do.
//
// WHY A MIGRATION AS WELL. Forward-only is not enough, and here it is actively
// harmful. `METRIC_DOCUMENT_REACH` now declares the slug REACHABLE, which is what
// removes "Waist Circumference" from the flat Biomarkers browser
// (lib/body-metric-analytes.ts). A reading already stored as a `medical_records` row
// would therefore leave the catalog WITHOUT arriving on the chart — visible nowhere,
// which is precisely the stranding that registry exists to prevent, and the
// "uncatalogued twin of its own slug" split-series problem Group 1 of #2322 is about.
// So the rows move, once, here (AGENTS.md: "Put one-shot data moves in a migration,
// not a settings flag").
//
// WHICH ROWS. Only rows this build's own recognizer would have projected: the frozen
// name/LOINC vocabulary below (a literal, not a read of the live module — a shipped
// migration must not change behaviour when a later release widens the recognizer, the
// same discipline migration 178's frozen rename table follows) plus a numeric value
// that survives the same cm conversion and 30–200 cm plausibility band. A waist/hip
// RATIO is an explicit negative on both axes. Anything the converter refuses stays a
// record, exactly as it would at ingest.
//
// AND THE ROW IS THEN DELETED, not left behind — because `withoutCapturedWaistCircs`
// deletes it at ingest, and converging to a DIFFERENT state than the forward path
// produces would be a second source of truth for the same reading. A row a child table
// still references (a follow-up lab, a projected medication, a care-plan item) is
// SKIPPED instead: an FK parent is a bigger claim than this issue makes, and such a
// row cannot be a waist measurement in practice. It keeps its value and its document.
//
// WHAT ELSE TOOK A NAME FROM IT (the AGENTS.md row-ops checklist, enumerated):
//   1. canonical_biomarkers — the ai-coined vocabulary row an AI import minted for
//      the name, which is what put it under Data → Coverage → "Uncatalogued items".
//      Only ever `source = 'ai'`; a curated row is untouchable (the #2306 rule), and
//      the dataset ships none for this name by the ruling.
//   2. saved_items (kind='biomarker') — the ★ on a name that no longer charts as a
//      biomarker. The quantity is still starrable, under its metric key.
//   3. upcoming_dismissals — the retest snooze `biomarker:<family>` and the
//      flagged-result acknowledgment `biomarker-flag:<family>`.
//   4. coverage_gaps (kind='biomarker') — the tracked catalog gap.
// Each is dropped only when the profile has no identity-carrying `medical_records`
// row left under the name, so a database whose rows were skipped above keeps its
// side-state intact.
//
// Deliberately NOT touched: goals.biomarker_name and protocols.outcome_keys, which
// are USER-AUTHORED (the #2318 posture — silently deleting someone's goal is a bigger
// claim than this issue makes), and the source documents, which stay stored.
//
// NO SCHEMA CHANGE. `metric_samples` is a generic (profile, metric, date, value)
// store, so the third length measure needs no column and no table — the same reason
// height and head circumference needed none. Nothing is added to lib/owned-tables.ts
// because no table is created.
//
// Idempotent: a second run finds no candidate `medical_records` rows (they are gone)
// and writes nothing.

// The recognizer's vocabulary, FROZEN at this migration's release. Kept in sync with
// lib/waist-circ-extract.ts by review, not by import — see the header.
const WAIST_NAME_KEYS = new Set(
  [
    "Waist Circumference",
    "Waist Circumference at Umbilicus",
    "Waist Circumference at Umbilicus by Tape Measure",
    "Waist Girth",
  ].map((n) => normalizeCanonicalKey(n))
);

const WAIST_LOINCS = new Set(["8280-0", "56086-2", "56115-9"]);
// A unitless ratio is never a length, on the LOINC axis as well as the name one.
const WAIST_RATIO_LOINCS = new Set(["60803-4"]);

const CM_PER_IN = 2.54;
const CM_PER_M = 100;

function toCm(value: number, unit: string | null): number | null {
  const u = (unit ?? "").toLowerCase().replace(/[^a-z]/g, "");
  let cm: number;
  if (u === "cm" || u === "centimeter" || u === "centimeters") cm = value;
  else if (u === "in" || u === "ini" || u === "inch" || u === "inches")
    cm = value * CM_PER_IN;
  else if (u === "m" || u === "meter" || u === "meters") cm = value * CM_PER_M;
  else return null;
  if (cm < 30 || cm > 200) return null;
  return Math.round(cm * 10) / 10;
}

interface CandidateRow {
  id: number;
  date: string;
  name: string;
  canonical_name: string | null;
  loinc: string | null;
  value_num: number | null;
  unit: string | null;
  source: string | null;
}

function isWaistRow(r: CandidateRow): boolean {
  if (r.loinc && WAIST_RATIO_LOINCS.has(r.loinc)) return false;
  if (r.loinc && WAIST_LOINCS.has(r.loinc)) return true;
  return [r.canonical_name ?? "", r.name].some((n) => {
    const key = normalizeCanonicalKey(n);
    return key !== "" && WAIST_NAME_KEYS.has(key);
  });
}

// The non-cascading FK parents of medical_records, as (table, column) pairs. A table
// or column a given database does not have is skipped rather than assumed — the
// migration runs against every historical shape.
const CHILD_LINKS: readonly { table: string; column: string }[] = [
  { table: "followup_labs", column: "source_record_id" },
  { table: "followup_labs", column: "result_record_id" },
  { table: "intake_items", column: "source_record_id" },
  { table: "care_plan_items", column: "source_record_id" },
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

    // A sample already covering (profile, date) — from ANY source. The import path
    // defers rather than stacking a second point for a date; so does this.
    const covered = db.prepare(
      `SELECT 1 FROM metric_samples
         WHERE profile_id = ? AND metric = 'waist_circumference_cm' AND date = ?
         LIMIT 1`
    );
    const insSample = db.prepare(
      `INSERT OR IGNORE INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, ?, 'waist_circumference_cm', ?, ?, ?, ?)`
    );
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

    // The names actually seen on moved rows, per profile — the side-state sweep keys
    // on what the DATA said, never on the one spelling this file happens to name.
    const movedNames = new Map<number, Set<string>>();

    for (const profileId of profiles) {
      const rows = db
        .prepare(
          `SELECT id, date, name, canonical_name, loinc, value_num, unit, source
             FROM medical_records
            WHERE profile_id = ?
              AND (name LIKE '%waist%' OR canonical_name LIKE '%waist%'
                   OR loinc IN ('8280-0', '56086-2', '56115-9'))
            ORDER BY date, id`
        )
        .all(profileId) as CandidateRow[];

      for (const r of rows) {
        if (!isWaistRow(r)) continue;
        if (r.value_num == null) continue;
        const cm = toCm(r.value_num, r.unit);
        if (cm == null) continue;
        if (referenced.some((stmt) => stmt.get(r.id))) continue;
        if (!covered.get(profileId, r.date)) {
          insSample.run(
            profileId,
            r.source ?? "manual",
            r.date,
            r.date,
            r.date,
            cm
          );
        }
        delRecord.run(profileId, r.id);
        const label = (r.canonical_name ?? "").trim() || r.name.trim();
        if (!label) continue;
        const set = movedNames.get(profileId) ?? new Set<string>();
        set.add(label);
        movedNames.set(profileId, set);
      }
    }

    if (movedNames.size === 0) return;

    // Side-state sweep, per profile, per name that lost its last identity-carrying row.
    const orphaned = new Set<string>();
    for (const [profileId, names] of movedNames) {
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
    // names (the #2318 pass's posture), never by an unscoped read of a
    // profile-owned table.
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
  id: 180,
  name: "180-waist-circumference-metric",
  up,
};
