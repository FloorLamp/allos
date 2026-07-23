import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 101 (issue #1281 — corrective to migration 092). Migration 092's unpaired-
// prescription projection (its step D) SKIPPED a legacy medical_records prescription row
// whose name was blank/whitespace (`if (!r.name?.trim()) continue`) — so NO medication
// was created for it and its visit-link decision was never re-keyed — yet 092's later
// steps ran UNCONDITIONALLY: step F deleted every `domain = 'record'` visit-link decision
// and step G deleted every `category = 'prescription'` medical_records row. A malformed
// blank-name prescription (e.g. a bad extraction) that carried a visit-link decision thus
// lost BOTH the record and its decision with no replacement medication — a silent,
// one-shot data loss.
//
// RECOVERABILITY. On a DB that already ran 092, the blank-name record and its decision
// were HARD-deleted (092 steps F/G) with no surviving trace in any table, so that data is
// genuinely UNRECOVERABLE — this migration cannot resurrect it. What it CAN do, and does,
// is append the non-lossy behavior 092 should have had, so the gap is closed for any
// blank-name prescription record that STILL EXISTS at this migration's runtime (there are
// none on an up-to-date DB — 092 already cleared the whole `prescription` category — so on
// every real deployment this is a pure no-op). Non-blank prescription records were already
// projected + deleted by 092 and are untouched here.
//
// For each surviving blank-name `category = 'prescription'` record, mirror 092's step-D
// projection with the bug fixed — a deterministic PLACEHOLDER name so the medication is
// never skipped — plus its initial open course, re-key its `record`-domain visit-link
// decisions onto the `medication` domain, then delete the retired record and its
// now-consolidated decisions. This keeps the #1178 invariant intact (intake_items is the
// SINGLE medication entity; ZERO prescription records remain).
//
// Self-contained (manifest freeze — never imports lib/): plain SQL / better-sqlite3
// statements. Replay-safe (the non-version-gated migrate() wrapper replays up()
// unconditionally): after the first run every blank-name prescription record is gone, so
// every step no-ops. Profile-scoped throughout — each statement carries the row's own
// profile_id via its source row, never reading one profile's data into another's.

// The deterministic, obviously-synthetic name a name-less imported prescription is
// projected under, so its medication is never silently dropped (#1281). Not PHI — a
// generic placeholder the user can rename.
const PLACEHOLDER_NAME = "Unnamed medication";

interface BlankRow {
  id: number;
  profile_id: number;
  date: string;
  document_id: number | null;
  provider_id: number | null;
  encounter_id: number | null;
  external_id: string | null;
}

// The set of surviving blank/whitespace-name prescription records, reused by both the
// per-record projection SELECT and the bulk cleanup db.exec statements so they operate
// on EXACTLY the same rows (a stable predicate — trim() is deterministic).
const BLANK_RX_PRED = `category = 'prescription' AND (name IS NULL OR trim(name) = '')`;

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const blanks = db
      .prepare(
        `SELECT r.id, r.profile_id, r.date, r.document_id, r.provider_id,
                r.encounter_id, r.external_id
           FROM medical_records r
          WHERE r.${BLANK_RX_PRED}`
      )
      .all() as BlankRow[];

    if (blanks.length === 0) return; // fast, guaranteed no-op on an up-to-date DB

    // A. Project a placeholder-named medication (+ initial open course) for each blank
    //    record and re-key its record-domain visit-link decisions onto the medication
    //    domain. These are prepared per-row because the med's new id drives its stable
    //    token; every statement carries the row's OWN profile_id (the INSERT's column,
    //    the copy's SELECT), so none reads across profiles.
    const insMed = db.prepare(
      `INSERT INTO intake_items
         (name, notes, active, condition, priority, kind, as_needed,
          document_id, source, provider_id, encounter_id, import_key, profile_id)
       VALUES (?, NULL, 1, 'daily', 'high', 'medication', 1,
               ?, 'extracted', ?, ?, ?, ?)`
    );
    const insCourse = db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, created_at)
       VALUES (?, ?, datetime('now'))`
    );
    const isIndividual = db.prepare(
      `SELECT 1 FROM providers WHERE id = ? AND type = 'individual'`
    );
    // Copy each record-domain decision onto the medication domain (identical to 092's
    // reKeyDecisions). INSERT OR IGNORE respects the (profile_id, domain, encounter_key,
    // target_key) uniqueness, so a pre-existing medication decision is left untouched.
    const copyDecision = db.prepare(
      `INSERT OR IGNORE INTO visit_link_decisions
         (profile_id, domain, encounter_key, target_key, decision, created_at)
       SELECT profile_id, 'medication', encounter_key, ?, decision, created_at
         FROM visit_link_decisions
        WHERE domain = 'record' AND target_key = ?`
    );

    for (const r of blanks) {
      const providerId =
        r.provider_id != null && isIndividual.get(r.provider_id)
          ? r.provider_id
          : null;
      const importKey =
        r.document_id != null
          ? `medimport:${r.document_id}|${PLACEHOLDER_NAME.toLowerCase()}`
          : null;
      const info = insMed.run(
        PLACEHOLDER_NAME,
        r.document_id,
        providerId,
        r.encounter_id,
        importKey,
        r.profile_id
      );
      const medId = Number(info.lastInsertRowid);
      insCourse.run(medId, r.date);

      const medToken = importKey ? `ext:${importKey}` : `id:${medId}`;
      const recToken = r.external_id ? `ext:${r.external_id}` : `id:${r.id}`;
      copyDecision.run(medToken, recToken);
    }

    // B. Delete the now-consolidated record-domain decisions of the blank records
    //    (their medication twins exist now), keyed by each record's stable token —
    //    reconstructed with the SAME `external_id truthy ? ext:… : id:…` rule the
    //    re-key used above. Bulk db.exec, scoped to the blank set by subquery.
    db.exec(
      `DELETE FROM visit_link_decisions
        WHERE domain = 'record'
          AND target_key IN (
            SELECT CASE
                     WHEN external_id IS NOT NULL AND external_id != ''
                       THEN 'ext:' || external_id
                     ELSE 'id:' || id
                   END
              FROM medical_records WHERE ${BLANK_RX_PRED}
          )`
    );

    // C. Drop the source_record_id usage + the follow-up links that cite a blank record,
    //    so the delete below leaves no dangling REFERENCES (mirrors 092's step E, scoped
    //    to the blank set). Bulk db.exec.
    db.exec(
      `UPDATE intake_items SET source_record_id = NULL
        WHERE source_record_id IN (SELECT id FROM medical_records WHERE ${BLANK_RX_PRED})`
    );
    db.exec(
      `UPDATE care_plan_items SET source_kind = NULL, source_medical_record_id = NULL
        WHERE source_medical_record_id IN (
          SELECT id FROM medical_records WHERE ${BLANK_RX_PRED}
        )`
    );
    db.exec(
      `UPDATE care_plan_items SET resolved_by_medical_record_id = NULL
        WHERE resolved_by_medical_record_id IN (
          SELECT id FROM medical_records WHERE ${BLANK_RX_PRED}
        )`
    );

    // D. Delete the retired blank prescription records.
    db.exec(`DELETE FROM medical_records WHERE ${BLANK_RX_PRED}`);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 101,
  name: "101-recover-blank-name-prescriptions",
  up,
};
