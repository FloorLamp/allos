import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 092 (issue #1178, the one-shot data consolidation): make intake_items
// the SINGLE medication entity by retiring the paired medical_records prescription
// rows an import used to auto-project a medication FROM. Every imported prescription
// already lives as a kind='medication' intake_items row (carrying prescriber /
// pharmacy / rx / courses / indication / prescribed-date / encounter link); the
// twin medical_records category='prescription' row is a pure import-side artifact
// (a MANUAL medication never had one). This deletes those twins after carrying any
// prescription-only field onto the medication and re-keying its durable visit-link
// decisions from the prescription token to the medication's stable import key.
//
// Self-contained (manifest freeze — never imports lib/): the steps are plain SQL /
// better-sqlite3 statements. Replay-safe (the non-version-gated migrate() wrapper
// replays up() unconditionally): after the first run every prescription record is
// gone and every source_record_id is NULL, so every step below no-ops.
//
// Steps:
//   A. Backfill intake_items.import_key for every document-owned extracted med
//      (`medimport:<document_id>|<lower(name)>`) — the stable within-doc reprocess
//      key the med's visit-link decisions now anchor on (#1178 point 2).
//   B. Propagate a PAIRED prescription record's encounter_id onto its medication
//      (a tier-2 accepted "prescribed at this visit" link lived only on the record,
//      which is about to be deleted; a tier-1 FHIR link already set the med's own).
//   C. Re-key the record-domain visit-link decisions onto the MEDICATION domain: a
//      paired prescription's decision target token becomes the med's stable token
//      (`ext:<import_key>`, or `id:<medId>` for a documentless med). #1050/#1178.
//   D. Project a NEW medication for each UNPAIRED prescription record (no med back-
//      links it — the old AI/unstructured records + the cross-document duplicates the
//      pre-#1204 skip left as a records fallback). Minimal, conservative projection:
//      name/date/document/encounter/individual-prescriber carried, an initial open
//      course dated the record's date, as_needed=1 (never a fabricated reminder), a
//      stamped import_key; then its record-domain decisions re-key to the new med.
//   E. NULL every intake_items.source_record_id (the column's usage is dropped, #1178)
//      and the care_plan_items follow-up links that cite a prescription record, so the
//      deletes below leave no dangling REFERENCES.
//   F. Delete every leftover 'record'-domain decision (its 'medication' twin exists
//      now, and the domain is being removed from the visit-link engine).
//   G. Delete every medical_records category='prescription' row.
//
// Profile-scoped throughout (every statement carries the row's own profile_id via its
// source row); a one-shot consolidation keyed by row identity, never reading one
// profile's data into another's.

interface UnpairedRow {
  id: number;
  profile_id: number;
  name: string;
  date: string;
  document_id: number | null;
  provider_id: number | null;
  encounter_id: number | null;
  external_id: string | null;
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    // A. Backfill the stable import key for document-owned extracted meds.
    db.exec(
      `UPDATE intake_items
          SET import_key = 'medimport:' || document_id || '|' || lower(name)
        WHERE kind = 'medication' AND source = 'extracted'
          AND document_id IS NOT NULL AND import_key IS NULL`
    );

    // B. Carry a paired prescription record's accepted visit link onto its med (only
    //    where the med has no link yet — never clobber a tier-1 FHIR link).
    db.exec(
      `UPDATE intake_items
          SET encounter_id = (
            SELECT r.encounter_id FROM medical_records r
             WHERE r.id = intake_items.source_record_id
          )
        WHERE source_record_id IS NOT NULL
          AND encounter_id IS NULL
          AND (SELECT r.encounter_id FROM medical_records r
                WHERE r.id = intake_items.source_record_id) IS NOT NULL`
    );

    // C. Re-key paired record-domain decisions onto the medication domain.
    const pairs = db
      .prepare(
        `SELECT ii.id AS medId, ii.import_key AS importKey,
                r.id AS recId, r.external_id AS recExt
           FROM intake_items ii
           JOIN medical_records r ON r.id = ii.source_record_id
          WHERE ii.source_record_id IS NOT NULL
            AND r.category = 'prescription'`
      )
      .all() as {
      medId: number;
      importKey: string | null;
      recId: number;
      recExt: string | null;
    }[];
    reKeyDecisions(db, pairs);

    // D. Project a medication for every UNPAIRED prescription record.
    const unpaired = db
      .prepare(
        `SELECT r.id, r.profile_id, r.name, r.date, r.document_id, r.provider_id,
                r.encounter_id, r.external_id
           FROM medical_records r
          WHERE r.category = 'prescription'
            AND NOT EXISTS (
              SELECT 1 FROM intake_items ii WHERE ii.source_record_id = r.id
            )`
      )
      .all() as UnpairedRow[];

    const insMed = db.prepare(
      `INSERT INTO intake_items
         (name, notes, active, condition, priority, kind, as_needed,
          document_id, source, provider_id, encounter_id, import_key, profile_id)
       VALUES (?, NULL, 1, 'daily', 'high', 'medication', 1,
               ?, 'extracted', ?, ?, ?, ?)`
    );
    const insCourse = db.prepare(
      `INSERT INTO medication_courses
         (item_id, started_on, document_id, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    );
    const isIndividual = db.prepare(
      `SELECT 1 FROM providers WHERE id = ? AND type = 'individual'`
    );
    for (const r of unpaired) {
      if (!r.name?.trim()) continue;
      const providerId =
        r.provider_id != null && isIndividual.get(r.provider_id)
          ? r.provider_id
          : null;
      const importKey =
        r.document_id != null
          ? `medimport:${r.document_id}|${r.name.toLowerCase()}`
          : null;
      const info = insMed.run(
        r.name,
        r.document_id,
        providerId,
        r.encounter_id,
        importKey,
        r.profile_id
      );
      const medId = Number(info.lastInsertRowid);
      insCourse.run(medId, r.date, r.document_id);
      reKeyDecisions(db, [
        { medId, importKey, recId: r.id, recExt: r.external_id },
      ]);
    }

    // E. Drop the source_record_id usage and the follow-up links citing a prescription
    //    record, so the deletes leave no dangling REFERENCES.
    db.exec(`UPDATE intake_items SET source_record_id = NULL`);
    db.exec(
      `UPDATE care_plan_items SET source_kind = NULL, source_medical_record_id = NULL
         WHERE source_medical_record_id IN (
           SELECT id FROM medical_records WHERE category = 'prescription'
         )`
    );
    db.exec(
      `UPDATE care_plan_items SET resolved_by_medical_record_id = NULL
         WHERE resolved_by_medical_record_id IN (
           SELECT id FROM medical_records WHERE category = 'prescription'
         )`
    );

    // F. Delete the leftover record-domain decisions (their medication twins exist).
    db.exec(`DELETE FROM visit_link_decisions WHERE domain = 'record'`);

    // G. Delete the retired prescription records.
    db.exec(`DELETE FROM medical_records WHERE category = 'prescription'`);
  });
  run.immediate();
}

// Copy each record-domain visit-link decision onto the medication domain, keyed on
// the med's stable token (ext:<import_key> when document-owned, else id:<medId>). The
// original record decision survives for now (deleted in bulk in step F). INSERT OR
// IGNORE respects the (profile_id, domain, encounter_key, target_key) uniqueness, so a
// medication decision that already exists is left untouched.
function reKeyDecisions(
  db: Database.Database,
  pairs: {
    medId: number;
    importKey: string | null;
    recId: number;
    recExt: string | null;
  }[]
): void {
  const copy = db.prepare(
    `INSERT OR IGNORE INTO visit_link_decisions
       (profile_id, domain, encounter_key, target_key, decision, created_at)
     SELECT profile_id, 'medication', encounter_key, ?, decision, created_at
       FROM visit_link_decisions
      WHERE domain = 'record' AND target_key = ?`
  );
  for (const p of pairs) {
    const medToken = p.importKey ? `ext:${p.importKey}` : `id:${p.medId}`;
    const recToken = p.recExt ? `ext:${p.recExt}` : `id:${p.recId}`;
    copy.run(medToken, recToken);
  }
}

export const migration: Migration = {
  id: 92,
  name: "092-consolidate-imported-prescriptions",
  up,
};
