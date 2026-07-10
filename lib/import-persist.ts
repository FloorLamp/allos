import type Database from "better-sqlite3";
import { db } from "./db";
import { documentSource, undeferredBodyMetrics } from "./body-metric-extract";
import {
  adoptProfileFromExtraction,
  adoptSmokingStatusFromImport,
  type ProfileAdoption,
} from "./settings";
import { smokingStatusToStructured } from "./social-history";
import {
  addCanonicalNames,
  reconcileFlags,
  ensureMedicationCourse,
  createImportedMedicationCourses,
} from "./queries";
import { parsePrescription, cleanMedicationName } from "./prescription-parse";
import { resolveProviderId } from "./providers-db";
import { cleanProviderInput, providerDedupKey } from "./providers";
import type {
  ImportedProvider,
  ImportedMedicationCourse,
} from "./health-import";
import type { PersistInput, PersistRecord } from "./import-shape";

// The single persist core shared by every document import path — the AI
// extractor (app/(app)/medical/actions.ts) and the deterministic CCD/XDM/SHC
// parser (lib/health-record-doc.ts). Having one writer means the delete-set
// (what a reprocess/delete clears), the insert columns, and the document
// finalize can't drift between paths. Callers reduce their extractor output to a
// PersistInput (lib/import-shape) and keep only their own extras (the AI path's
// today() fallback + supplement auto-suggest, the deterministic path's parse).

export interface PersistOutcome {
  immCount: number;
  recCount: number;
  // Total per-profile rows this import wrote across ALL footprint tables — the
  // "N items imported" the toast + Review feed report (#212). A SUPERSET of
  // immCount + recCount: it also covers allergies, conditions, encounters,
  // procedures, family history, care-plan items + goals, auto-structured
  // medications, body metrics, and height/head-circ samples. immCount/recCount
  // stay for the callers/tests that still tally those two kinds specifically.
  extractedCount: number;
  insertedRecordIds: number[];
}

// THE single source of truth for a document import's per-row footprint: every
// table an import writes, and how each row traces back to its source document.
// EVERY consumer that must touch a document's whole footprint derives its
// statements from this ONE list, so a table can never be handled in one place but
// leak in another (#201):
//   - clearImportedDocumentRows — the reprocess/delete delete-set;
//   - moveImportedDocumentRows — reassignDocument's cross-profile move.
// (The tables had drifted before this list existed: head-circ samples/allergies/
// conditions/encounters were added to the reprocess clear but not the delete path,
// then procedures/family_history/care_plan_items/care_goals were cleared+deleted
// but NOT moved on reassign — stranding them cross-profile with an FK-500 on the
// new owner's later delete. Binding both callers to this list makes that drift
// impossible.)
//
// `key` is how a row is tied to its document — and MUST match what
// persistDocumentImport writes:
//   - "document_id": the row carries the document_id (medical_records, allergies,
//     conditions, encounters, procedures, family_history, care_plan_items,
//     care_goals, and the auto-structured extracted medications, which ALSO carry
//     `extra: source = 'extracted'`).
//   - "source": the row carries the document's source STRING
//     (documentSource(docId)) rather than a document_id (body_metrics,
//     immunizations, and the height/head-circumference metric_samples, the latter
//     two isolated by their `extra` metric filter).
// `extra` is an additional bound-param-free AND predicate.
export interface ImportFootprintTable {
  table: string;
  key: "document_id" | "source";
  extra?: string;
}

export const IMPORT_FOOTPRINT_TABLES: readonly ImportFootprintTable[] = [
  { table: "medical_records", key: "document_id" },
  { table: "allergies", key: "document_id" },
  { table: "conditions", key: "document_id" },
  { table: "encounters", key: "document_id" },
  { table: "procedures", key: "document_id" },
  { table: "family_history", key: "document_id" },
  { table: "care_plan_items", key: "document_id" },
  { table: "care_goals", key: "document_id" },
  // Medications auto-structured from this document. Keyed on source='extracted' so
  // a manual med — even one pointing at no document — is never touched; child
  // dose/log rows cascade via their FKs.
  { table: "intake_items", key: "document_id", extra: "source = 'extracted'" },
  { table: "body_metrics", key: "source" },
  { table: "immunizations", key: "source" },
  { table: "metric_samples", key: "source", extra: "metric = 'height_cm'" },
  {
    table: "metric_samples",
    key: "source",
    extra: "metric = 'head_circumference_cm'",
  },
];

// The value bound to a footprint table's key column for `docId`: the raw id for a
// document_id-keyed table, the document source string for a source-keyed one.
function footprintKeyValue(
  t: ImportFootprintTable,
  docId: number,
  source: string
): number | string {
  return t.key === "document_id" ? docId : source;
}

// The trailing WHERE predicate a footprint statement appends after its `<key> = ?`
// bind — the profile scope plus any table-specific `extra` filter. Kept here so
// clear + move build identical predicates from the ONE list.
function footprintScope(t: ImportFootprintTable): string {
  return `profile_id = ?${t.extra ? ` AND ${t.extra}` : ""}`;
}

// Delete every row a document import produced, across ALL footprint tables. Shared
// by BOTH the reprocess delete-set (persistDocumentImport below, which clears the
// old set before re-inserting) and deleteMedicalDocument
// (app/(app)/medical/actions.ts, which clears it on delete) — driven off
// IMPORT_FOOTPRINT_TABLES so the two can't drift. Every statement is
// profile_id-scoped (profile-scoping rule); manual rows carry a NULL document_id or
// a non-document source and are never touched.
//
// Caller-specific deletes stay OUT of here: the reprocess path's cross-document
// social-smoking supersession (it deletes OTHER documents' smoking rows) and
// deleteMedicalDocument's medical_documents-row drop + starred-biomarker cleanup.
// A document's OWN social-smoking condition carries its document_id, so the
// conditions delete below removes it on document delete without the supersession.
export function clearImportedDocumentRows(
  profileId: number,
  docId: number
): void {
  const source = documentSource(docId);
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    db.prepare(
      `DELETE FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}`
    ).run(footprintKeyValue(t, docId, source), profileId);
  }
}

// Re-point a document's ENTIRE per-row footprint from one profile to another — the
// move counterpart of clearImportedDocumentRows, iterating the SAME
// IMPORT_FOOTPRINT_TABLES list so a delete and a reassign can never disagree about
// which tables a document owns (#201). Runs inside reassignDocument's transaction;
// the parent medical_documents row + the starred-biomarker cleanup stay with the
// caller. Every UPDATE is scoped to the SOURCE profile so no other profile's rows
// can be touched; child rows (intake_item_doses/_logs/_pairs, medication_courses,
// side effects) carry no profile_id and follow their parent intake_items row.
export function moveImportedDocumentRows(
  srcProfileId: number,
  destProfileId: number,
  docId: number
): void {
  const source = documentSource(docId);
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    db.prepare(
      `UPDATE ${t.table} SET profile_id = ? WHERE ${t.key} = ? AND ${footprintScope(t)}`
    ).run(destProfileId, footprintKeyValue(t, docId, source), srcProfileId);
  }
}

// Total per-profile rows a document import produced across ALL footprint tables —
// the true "N items imported" tally the toast + Review feed report (#212). Driven
// off the SAME IMPORT_FOOTPRINT_TABLES list as clearImportedDocumentRows /
// moveImportedDocumentRows, so a table added to the footprint is counted
// automatically and the three consumers can't drift (the bug this fixes: the old
// tally was a hand-maintained `immCount + recCount` that missed seven clinical
// kinds and read "0 records" for an encounter-only import). Providers are a GLOBAL
// registry, not a footprint table, so they're correctly excluded. Every COUNT is
// profile_id-scoped. Run AFTER the insert loops (inside persistDocumentImport's
// transaction), so it counts exactly what landed — a deferred/deduped row that was
// never written isn't counted, and a reprocess reflects the replaced set.
export function countImportedDocumentRows(
  profileId: number,
  docId: number
): number {
  const source = documentSource(docId);
  let total = 0;
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}`
      )
      .get(footprintKeyValue(t, docId, source), profileId) as { n: number };
    total += row.n;
  }
  return total;
}

// Write one document's parsed contents, replacing any rows it previously
// produced (so this doubles as the reprocess path) and marking the document
// 'done'. One transaction; returns the inserted record ids + counts. Does NOT
// run the profile/flag follow-ups — see applyImportFollowups, which callers run
// in their own best-effort block so a follow-up throw can't un-finalize a
// document whose data is already committed.
export function persistDocumentImport(
  profileId: number,
  docId: number,
  input: PersistInput
): PersistOutcome {
  const docSource = documentSource(docId);

  // Resolve every captured provider (per-record/immunization performers + the
  // section-level Care Teams) into the shared GLOBAL registry, memoized by dedup
  // key so one INSERT per distinct provider. Done up front, outside
  // the per-document transaction, because the providers table is global and its
  // resolve-or-create is independently idempotent — a reprocess re-resolves to the
  // same rows and never coins a duplicate. Returns the shared row id to stamp onto
  // the profile-owned immunization/record row's provider_id.
  const providerIdCache = new Map<string, number | null>();
  const providerIdFor = (
    p: ImportedProvider | null | undefined
  ): number | null => {
    const clean = cleanProviderInput(p);
    if (!clean) return null;
    const key = providerDedupKey(clean);
    if (providerIdCache.has(key)) return providerIdCache.get(key)!;
    const id = resolveProviderId(clean);
    providerIdCache.set(key, id);
    return id;
  };
  // Seed the registry with the care-team providers even though they aren't linked
  // to a specific row.
  for (const p of input.providers) providerIdFor(p);

  const insImm = db.prepare(
    `INSERT OR IGNORE INTO immunizations
       (date, vaccine, dose_label, notes, source, external_id, provider_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const insMetric = db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, source, profile_id)
     VALUES (?,?,?,?,?,?)`
  );
  // Which measures a date already has on any existing body_metrics row, so a
  // document row is dropped only when it adds nothing new (undeferredBodyMetrics).
  const coverage = db.prepare(
    `SELECT MAX(weight_kg IS NOT NULL) AS w,
            MAX(body_fat_pct IS NOT NULL) AS bf,
            MAX(resting_hr IS NOT NULL) AS rhr
       FROM body_metrics WHERE date = ? AND profile_id = ?`
  );
  // Body height lives in metric_samples (metric 'height_cm'), not body_metrics
  //. A point sample uses the date as both start/end. INSERT OR IGNORE keeps
  // the (profile_id, metric, start_time, end_time) natural key idempotent; the
  // per-source delete in the transaction clears this document's own prior rows on
  // reprocess. Integration rows carry full ISO timestamps, so they never collide.
  const insHeight = db.prepare(
    `INSERT OR IGNORE INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, ?, 'height_cm', ?, ?, ?, ?)`
  );
  // Does another source (manual/integration/another document) already have a height
  // for this date? Read AFTER this document's own height rows are cleared, so a
  // reprocess doesn't see itself. If so, the document defers — mirroring how a
  // body_metrics row defers to an existing measure — rather than stacking a point.
  const heightCovered = db.prepare(
    `SELECT 1 FROM metric_samples
       WHERE profile_id = ? AND metric = 'height_cm' AND date = ? LIMIT 1`
  );
  // Head circumference lives in metric_samples (metric 'head_circumference_cm'),
  // exactly like height. Same idempotency: INSERT OR IGNORE on the
  // (profile_id, metric, start_time, end_time) natural key, a per-source delete on
  // reprocess (below), and a defer probe so a manual/integration/another-document
  // reading for a date is never overwritten.
  const insHeadCirc = db.prepare(
    `INSERT OR IGNORE INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, ?, 'head_circumference_cm', ?, ?, ?, ?)`
  );
  const headCircCovered = db.prepare(
    `SELECT 1 FROM metric_samples
       WHERE profile_id = ? AND metric = 'head_circumference_cm' AND date = ? LIMIT 1`
  );
  // Scope a parsed external_id to THIS document. The per-profile unique index on
  // external_id otherwise makes a dose/lab that appears in two separately
  // uploaded documents insert only once (under whichever document imported it
  // first) — and the delete-by-source cascade then removes that single row when
  // that document is deleted, silently taking the reading away from the other
  // document that legitimately still contains it. Prefixing with the document
  // source keeps dedup within a document (and across its reprocesses) while
  // giving each document its own physical row, so a delete never orphans another.
  const scopedExternalId = (raw: string | null): string | null =>
    raw == null ? null : `${docSource}|${raw}`;

  // One insert covers every record type (lab / vital / prescription / …).
  // external_id is nullable — the deterministic path sets it (dedup via the
  // per-profile partial-unique index); the AI path leaves it null and relies on
  // the delete-by-document_id above.
  const insRec = db.prepare(
    `INSERT OR IGNORE INTO medical_records
       (date, category, name, value, value_num, unit, reference_range, notes,
        panel, flag, canonical_name, document_id, source, external_id, provider_id,
        profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  // Allergies + problem-list conditions. Own tables, same idempotency
  // as the records path: a per-document delete-set clears this document's prior rows
  // (below), then INSERT OR IGNORE dedups within the document via the per-profile
  // unique external_id index (scoped with the document source so two documents each
  // keep their own physical row and a delete never orphans another's).
  const insAllergy = db.prepare(
    `INSERT OR IGNORE INTO allergies
       (substance, substance_code, substance_code_system, reaction, severity,
        status, onset_date, source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insCondition = db.prepare(
    `INSERT OR IGNORE INTO conditions
       (name, code, code_system, status, onset_date, resolved_date,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  // Encounters / visits. Same idempotency as records/conditions: a
  // per-document delete-set (below) clears this document's prior rows, then INSERT
  // OR IGNORE dedups within the document via the per-profile unique external_id
  // index (scoped with the document source). provider_id / location_provider_id are
  // the resolved shared-registry ids for the attending clinician + facility.
  const insEncounter = db.prepare(
    `INSERT OR IGNORE INTO encounters
       (date, end_date, type, class_code, reason, diagnoses, notes,
        provider_id, location_provider_id, source, document_id, external_id,
        profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Procedures + family history. Same idempotency as records/conditions: the
  // per-document delete-set (above) clears this document's prior rows, then INSERT
  // OR IGNORE dedups within the document via the per-profile unique external_id index
  // (scoped with the document source). A procedure's provider_id is the resolved
  // shared-registry id for the performing clinician.
  const insProcedure = db.prepare(
    `INSERT OR IGNORE INTO procedures
       (name, code, code_system, date, provider_id, source, document_id,
        external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const insFamilyHistory = db.prepare(
    `INSERT OR IGNORE INTO family_history
       (relation, condition, code, code_system, onset_age, deceased,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  // Care plan items + care goals. Same idempotency: the per-document delete-set
  // clears prior rows, then INSERT OR IGNORE dedups within the document via the
  // per-profile unique external_id index. A care-plan item's provider_id is the
  // resolved shared-registry id for the ordering clinician.
  const insCarePlanItem = db.prepare(
    `INSERT OR IGNORE INTO care_plan_items
       (description, code, code_system, category, planned_date, status,
        provider_id, source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insCareGoal = db.prepare(
    `INSERT OR IGNORE INTO care_goals
       (description, code, code_system, target_date, status,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  // Structured medications: a prescription record is ALSO projected
  // into a kind='medication' intake_items row (source='extracted', document_id),
  // so the passport reads it as a real medication rather than only via the
  // medical_records fallback. These statements back that projection.
  //
  // Existing medications (manual OR from another document) the profile already
  // has — read AFTER this document's own extracted meds are cleared, so a
  // reprocess doesn't see its own prior rows and a manual med of the same name
  // blocks the auto-structured duplicate. Compared on the cleaned/grouping name.
  const existingMeds = db.prepare(
    "SELECT name FROM intake_items WHERE profile_id = ? AND kind = 'medication'"
  );
  const insMed = db.prepare(
    `INSERT INTO intake_items
       (name, notes, active, condition, priority, kind,
        prescriber, pharmacy, rx_number, as_needed,
        document_id, source, profile_id)
     VALUES (?,?,1,'daily','high','medication',?,?,?,?,?,'extracted',?)`
  );
  const insMedDose = db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?,?,?, 'any', ?)`
  );

  const insertedRecordIds: number[] = [];
  let immCount = 0;
  let recCount = 0;
  let extractedCount = 0;

  const tx = db.transaction(() => {
    // Replace this document's prior rows (a no-op on first import; on reprocess
    // it clears the old set) across every table an import writes — including the
    // previously auto-structured meds, cleared here before the existing-meds set
    // is read below so a reprocess replaces (never duplicates) them. This is the
    // SAME shared helper deleteMedicalDocument runs, so the two delete-sets can't
    // drift. Manual rows are never touched.
    clearImportedDocumentRows(profileId, docId);
    // Smoking status is single-valued: a profile keeps AT MOST ONE
    // social-history smoking-status condition, and the latest import wins. This
    // supersession is IMPORT-specific — it deletes OTHER documents' smoking rows —
    // so it stays here, out of the shared per-document helper. The per-document
    // delete-set above + the source-scoped external_id don't supersede ACROSS
    // documents, so re-uploading an older CCD ("Current smoker") then a newer one
    // ("Former smoker") as separate documents would otherwise leave two
    // contradictory active rows. When THIS document carries a smoking status, clear
    // EVERY prior social-smoking condition for the profile (across documents/sources)
    // first; the freshly-imported status is then inserted by the conditions loop
    // below. Strictly scoped to profile_id AND the social-smoking external_id
    // namespace — real ccda:condition:* problem-list rows are never touched. The
    // stored external_id is source-prefixed ("<source>|ccda:social-smoking:<code>"),
    // hence the leading-% match. Idempotent: reimporting the same document clears
    // then re-inserts the same single row.
    const hasSmokingStatus = input.conditions.some((c) =>
      c.external_id?.startsWith("ccda:social-smoking:")
    );
    if (hasSmokingStatus) {
      db.prepare(
        "DELETE FROM conditions WHERE profile_id = ? AND external_id LIKE '%ccda:social-smoking:%'"
      ).run(profileId);
    }

    for (const im of input.immunizations) {
      const info = insImm.run(
        im.date,
        im.vaccine,
        im.dose_label,
        im.notes,
        docSource,
        scopedExternalId(im.external_id),
        providerIdFor(im.provider),
        profileId
      );
      if (info.changes > 0) immCount++;
    }
    // A document defers to existing body-metrics rows on the same date (manual,
    // integration, or another document) so a retrospective scan can't stack a
    // duplicate point or outrank a manual entry — but only per measure: a
    // document's weight for a date that only has an integration resting-HR row is
    // still stored (undeferredBodyMetrics, tested). `coverage` is the DB probe.
    const rowsToInsert = undeferredBodyMetrics(input.bodyMetrics, (date) => {
      const c = coverage.get(date, profileId) as
        { w: number | null; bf: number | null; rhr: number | null } | undefined;
      return {
        weight_kg: !!c?.w,
        body_fat_pct: !!c?.bf,
        resting_hr: !!c?.rhr,
      };
    });
    for (const w of rowsToInsert) {
      insMetric.run(
        w.date,
        w.weight_kg,
        w.body_fat_pct,
        w.resting_hr,
        docSource,
        profileId
      );
    }
    // Body-height samples → metric_samples. Defer a date another source
    // already covers (never overwrite manual/integration/another-document height),
    // else insert a point sample keyed by the date. heightsFromReadings already
    // reduced to one plausible value per date.
    for (const h of input.heights) {
      if (heightCovered.get(profileId, h.date)) continue;
      insHeight.run(profileId, docSource, h.date, h.date, h.date, h.height_cm);
    }
    // Head-circumference samples → metric_samples, same defer-then-insert
    // rule as height: never overwrite a date another source already covers.
    for (const h of input.headCircs) {
      if (headCircCovered.get(profileId, h.date)) continue;
      insHeadCirc.run(
        profileId,
        docSource,
        h.date,
        h.date,
        h.date,
        h.head_circumference_cm
      );
    }
    for (const r of input.records) {
      const info = insRec.run(
        r.date,
        r.category,
        r.name,
        r.value,
        r.value_num,
        r.unit,
        r.reference_range,
        r.notes,
        r.panel,
        r.flag,
        r.canonical,
        docId,
        r.source,
        scopedExternalId(r.external_id),
        providerIdFor(r.provider),
        profileId
      );
      if (info.changes > 0) {
        recCount++;
        insertedRecordIds.push(Number(info.lastInsertRowid));
      }
    }
    for (const a of input.allergies) {
      insAllergy.run(
        a.substance,
        a.substance_code,
        a.substance_code_system,
        a.reaction,
        a.severity,
        a.status,
        a.onset_date,
        docSource,
        docId,
        scopedExternalId(a.external_id),
        profileId
      );
    }
    for (const c of input.conditions) {
      insCondition.run(
        c.name,
        c.code,
        c.code_system,
        c.status,
        c.onset_date,
        c.resolved_date,
        docSource,
        docId,
        scopedExternalId(c.external_id),
        profileId
      );
    }
    // Seed the STRUCTURED smoking record (#83) from the imported social-history
    // smoking condition, so the risk-gated screening rules (lung LDCT / AAA) read
    // structured data without a re-derivation drift. The condition row stays the
    // /conditions display artifact; adoptSmokingStatusFromImport skips a manual
    // entry (a user correction always wins) and otherwise seeds status only —
    // pack-years aren't in a CCD. Single-valued per profile, so one winning row.
    const smokingCond = input.conditions.find((c) =>
      c.external_id?.startsWith("ccda:social-smoking:")
    );
    if (smokingCond) {
      adoptSmokingStatusFromImport(
        profileId,
        smokingStatusToStructured({
          code: smokingCond.code,
          display: smokingCond.name,
        })
      );
    }
    for (const e of input.encounters) {
      insEncounter.run(
        e.date,
        e.end_date,
        e.type,
        e.class_code,
        e.reason,
        e.diagnoses.length ? e.diagnoses.join("; ") : null,
        e.notes,
        providerIdFor(e.provider),
        providerIdFor(e.location),
        docSource,
        docId,
        scopedExternalId(e.external_id),
        profileId
      );
    }
    for (const p of input.procedures) {
      insProcedure.run(
        p.name,
        p.code,
        p.code_system,
        p.date,
        providerIdFor(p.provider),
        docSource,
        docId,
        scopedExternalId(p.external_id),
        profileId
      );
    }
    for (const f of input.familyHistory) {
      insFamilyHistory.run(
        f.relation,
        f.condition,
        f.code,
        f.code_system,
        f.onset_age,
        f.deceased,
        docSource,
        docId,
        scopedExternalId(f.external_id),
        profileId
      );
    }
    for (const c of input.carePlanItems) {
      insCarePlanItem.run(
        c.description,
        c.code,
        c.code_system,
        c.category,
        c.planned_date,
        c.status,
        providerIdFor(c.provider),
        docSource,
        docId,
        scopedExternalId(c.external_id),
        profileId
      );
    }
    for (const g of input.careGoals) {
      insCareGoal.run(
        g.description,
        g.code,
        g.code_system,
        g.target_date,
        g.status,
        docSource,
        docId,
        scopedExternalId(g.external_id),
        profileId
      );
    }
    // Project each prescription record into a structured medication row. The
    // name-dedup set starts from the meds that survived the delete-set (manual +
    // other documents') and grows as we insert, so neither a manual med nor a
    // repeated prescription within this document produces a duplicate. Skipped
    // rows still live on in medical_records (inserted above); the passport's
    // name-based fallback shows them until/unless they're structured.
    persistExtractedMedications(profileId, docId, input.records, {
      existing: existingMeds.all(profileId) as { name: string }[],
      insMed,
      insMedDose,
    });
    // The toast + Review feed report ONE "N items imported" number. Tally it off
    // the footprint tables here — after every insert loop — so it counts every
    // clinical kind an import wrote, not just the immunizations + records the old
    // `immCount + recCount` saw (#212).
    extractedCount = countImportedDocumentRows(profileId, docId);
    db.prepare(
      `UPDATE medical_documents
         SET extraction_status = 'done', extracted_count = ?, doc_type = ?,
             source = ?, document_date = ?, patient_name = ?, raw_extraction = ?,
             model = ?, import_report = ?, extraction_error = NULL
       WHERE id = ? AND profile_id = ?`
    ).run(
      extractedCount,
      input.meta.docType,
      input.meta.source,
      input.meta.documentDate,
      input.meta.patientName,
      input.meta.raw,
      input.meta.model,
      // The import DEBUGGER report — refreshed on every
      // reprocess so it always reflects the current parse (idempotent).
      input.meta.importReport,
      docId,
      profileId
    );
  });
  tx();

  return { immCount, recCount, extractedCount, insertedRecordIds };
}

type Stmt = Database.Statement;

// Project a document's prescription records into structured kind='medication'
// intake_items rows (+ their dose rows). Runs inside persistDocumentImport's
// transaction, after this document's prior extracted meds were cleared.
//
// Dedup: an extracted med whose cleaned/grouping name already belongs to an
// existing medication (manual or from another document) is SKIPPED — it stays a
// medical_records prescription and shows via the passport fallback, so the same
// medication is never listed twice. Repeated prescriptions within one document
// collapse the same way. Scheduling is conservative (see prescription-parse): a
// clear sig becomes scheduled doses; an unparseable one becomes an as-needed med
// (never scheduled-due) rather than a fabricated daily reminder.
function persistExtractedMedications(
  profileId: number,
  docId: number,
  records: PersistRecord[],
  ctx: { existing: { name: string }[]; insMed: Stmt; insMedDose: Stmt }
): void {
  const prescriptions = records.filter((r) => r.category === "prescription");
  if (prescriptions.length === 0) return;

  const seen = new Set(
    ctx.existing.map((m) => cleanMedicationName(m.name).toLowerCase())
  );

  // Group NEW (not already-present) prescriptions by cleaned drug name so
  // repeated prescriptions — or several MedicationStatements for one drug at
  // different periods — collapse into ONE medication carrying the UNION of their
  // derived courses. The FIRST occurrence's parse (sig / strength /
  // schedule) wins; later ones only contribute courses. A manual / other-document
  // med of the same name blocks the whole group (it stays a records fallback).
  const groups = new Map<
    string,
    {
      med: ReturnType<typeof parsePrescription>;
      courses: ImportedMedicationCourse[];
    }
  >();
  const order: string[] = [];
  for (const r of prescriptions) {
    if (!r.name?.trim()) continue;
    const med = parsePrescription({
      name: r.name,
      value: r.value,
      unit: r.unit,
      notes: r.notes,
    });
    const key = med.name.toLowerCase();
    if (seen.has(key)) continue; // already a manual/other-doc med — don't duplicate
    let g = groups.get(key);
    if (!g) {
      g = { med, courses: [] };
      groups.set(key, g);
      order.push(key);
    }
    if (r.courses && r.courses.length) g.courses.push(...r.courses);
  }

  for (const key of order) {
    const { med, courses } = groups.get(key)!;
    const info = ctx.insMed.run(
      med.name,
      med.sig, // directions kept as the row's notes (may be null)
      med.prescriber,
      med.pharmacy,
      med.rxNumber,
      med.asNeeded ? 1 : 0,
      // document_id — traces the row back to its source document for the
      // delete-set; profile_id closes the insert.
      docId,
      profileId
    );
    const medId = Number(info.lastInsertRowid);

    // Courses: when the source carried effective period(s), create
    // one medication_courses row per DERIVED course (open/closed synced to
    // `active`, deduped by (item_id, started_on)). Otherwise fall back to the
    // Phase-1 single open initial course (started on the med's created_at). Both
    // paths are idempotent — a reprocess first deletes the med, cascading its
    // courses, then re-creates from the import.
    if (courses.length > 0) {
      createImportedMedicationCourses(profileId, medId, courses);
    } else {
      ensureMedicationCourse(profileId, medId, null);
    }

    // Dose rows: a scheduled med gets one row per inferred time bucket; an
    // as-needed med gets a single row only when a strength is known (so its
    // strength still shows) — never a scheduled reminder.
    if (!med.asNeeded && med.timeBuckets.length > 0) {
      med.timeBuckets.forEach((bucket, i) => {
        ctx.insMedDose.run(medId, med.strength, bucket, i);
      });
    } else if (med.strength) {
      ctx.insMedDose.run(medId, med.strength, null, 0);
    }
  }
}

// The best-effort follow-ups every import runs after its rows are committed:
// backfill the profile's sex/birthdate (never overwriting a chosen value),
// register canonical names, and reconcile out-of-range flags (all rows when a
// new sex was learned, else just the imported ones). Kept separate from
// persistDocumentImport so a caller can run it outside the "document is already
// done" boundary — a throw here must never flip the document back to 'failed'.
export function applyImportFollowups(
  profileId: number,
  opts: {
    demographics: PersistInput["demographics"];
    canonicalNames: string[];
    insertedRecordIds: number[];
  }
): ProfileAdoption {
  const adopted = adoptProfileFromExtraction(profileId, opts.demographics);
  addCanonicalNames(opts.canonicalNames);
  if (adopted.sexAdopted) reconcileFlags(profileId);
  else reconcileFlags(profileId, opts.insertedRecordIds);
  return adopted;
}
