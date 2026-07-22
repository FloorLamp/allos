import type Database from "better-sqlite3";
import { db, writeTx } from "./db";
import { documentSource, undeferredBodyMetrics } from "./body-metric-extract";
import {
  adoptProfileFromExtraction,
  adoptBloodTypeFromRecords,
  adoptSmokingStatusFromImport,
  type ProfileAdoption,
} from "./settings";
import { smokingStatusToStructured } from "./social-history";
import {
  addCanonicalNames,
  reconcileFlags,
  ensureMedicationCourse,
  createImportedMedicationCourses,
  addRenewalCourse,
  getMedMatchStates,
  recordPreventiveDone,
  sweepImmunizationDismissals,
  reapplyVisitLinkDecisions,
  type CourseAttribution,
  type MedMatchState,
} from "./queries";
import { matchAppointmentForEncounter } from "./appointment-encounter-match";
import { satisfiedRuleForCompletedKind } from "./preventive-appointment";
import { parsePrescription, strengthFromName } from "./prescription-parse";
import { medNameKey } from "./medication-record-match";
import {
  classifyReprescription,
  normalizeStrength,
} from "./medication-renewal";
import { resolveProviderId, resolveExactPrescriberId } from "./providers-db";
import { cleanProviderInput, providerDedupKey } from "./providers";
import type {
  ImportedProvider,
  ImportedMedicationCourse,
} from "./health-import";
import type { PersistInput, PersistRecord } from "./import-shape";
import { evictPreviewsForDocument } from "./reprocess-preview-cache";

// The single persist core shared by every document import path — the AI
// extractor (runExtraction in lib/medical-pipeline.ts) and the deterministic
// CCD/XDM/SHC parser (lib/health-record-doc.ts). Having one writer means the delete-set
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

// The import-footprint contract (the per-row footprint list + the side-effect
// inventory) lives in the pure lib/import-footprint.ts so the pure test tier can
// bind to it without opening a DB; the persist core imports it for its statements
// and re-exports it so existing `@/lib/import-persist` importers are unchanged.
import {
  IMPORT_FOOTPRINT_TABLES,
  IMPORT_SIDE_EFFECTS,
  type ImportFootprintTable,
  type ImportSideEffect,
} from "./import-footprint";
export {
  IMPORT_FOOTPRINT_TABLES,
  IMPORT_SIDE_EFFECTS,
  type ImportFootprintTable,
  type ImportSideEffect,
};

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
// (app/(app)/medical/document-actions.ts, which clears it on delete) — driven off
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
  // Row-ops side-state (#288): an appointment may link an encounter this document
  // produced (via "Log this visit" or the import auto-complete). encounters carry
  // no ON DELETE action, so NULL those back-links FIRST — otherwise deleting the
  // encounter (below, in the footprint loop) would trip the appointments.encounter_id
  // FK. A manual appointment (not in the footprint) is preserved, just unlinked.
  db.prepare(
    `UPDATE appointments SET encounter_id = NULL
       WHERE profile_id = ?
         AND encounter_id IN (
           SELECT id FROM encounters WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  // Row-ops side-state (#700): a follow-up (a manual care_plan_item) may link an
  // imaging study THIS document imported as its SOURCE finding, or a resolution may
  // cite it. imaging_studies carries no ON DELETE, so NULL those follow-up links
  // FIRST — otherwise deleting the study (in the footprint loop) would trip the
  // care_plan_items source/resolved FKs. A manual follow-up is preserved, just
  // de-linked (source_kind cleared so it degrades to a generic care-plan item).
  db.prepare(
    `UPDATE care_plan_items SET source_kind = NULL, source_imaging_study_id = NULL
       WHERE profile_id = ?
         AND source_imaging_study_id IN (
           SELECT id FROM imaging_studies WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  db.prepare(
    `UPDATE care_plan_items SET resolved_by_imaging_study_id = NULL
       WHERE profile_id = ?
         AND resolved_by_imaging_study_id IN (
           SELECT id FROM imaging_studies WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  // Row-ops side-state (#700 labs adapter): a flagged-lab follow-up may link a
  // medical_records reading THIS document imported as its SOURCE finding, or a
  // resolution may cite one. medical_records carries no ON DELETE for these FKs, so
  // NULL those follow-up links FIRST — otherwise deleting the readings (in the
  // footprint loop, where medical_records is cleared) would trip the care_plan_items
  // source/resolved FKs. A manual follow-up is preserved, just de-linked.
  db.prepare(
    `UPDATE care_plan_items SET source_kind = NULL, source_medical_record_id = NULL
       WHERE profile_id = ?
         AND source_medical_record_id IN (
           SELECT id FROM medical_records WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  db.prepare(
    `UPDATE care_plan_items SET resolved_by_medical_record_id = NULL
       WHERE profile_id = ?
         AND resolved_by_medical_record_id IN (
           SELECT id FROM medical_records WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  // Row-ops side-state (#705 dental adapter): a dental follow-up may link a
  // dental_procedures row THIS document imported as its SOURCE finding, or a
  // resolution may cite one. dental_procedures carries no ON DELETE for these FKs, so
  // NULL those follow-up links FIRST — otherwise deleting the records (in the
  // footprint loop) would trip the care_plan_items source/resolved FKs.
  db.prepare(
    `UPDATE care_plan_items SET source_kind = NULL, source_dental_procedure_id = NULL
       WHERE profile_id = ?
         AND source_dental_procedure_id IN (
           SELECT id FROM dental_procedures WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  db.prepare(
    `UPDATE care_plan_items SET resolved_by_dental_procedure_id = NULL
       WHERE profile_id = ?
         AND resolved_by_dental_procedure_id IN (
           SELECT id FROM dental_procedures WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  // Row-ops side-state (#1050/#1053): a record/med/condition/procedure/imaging/
  // immunization or illness_episode — possibly from ANOTHER document, or manual — may
  // link an encounter THIS document produced (encounter_id, no ON DELETE). NULL those
  // back-links FIRST so deleting the encounter (in the footprint loop) can't trip the
  // FK. A tier-1 link re-derives when its own document reprocesses; a tier-2 accepted
  // link re-applies via reapplyVisitLinkDecisions once both rows exist again.
  for (const table of [
    "medical_records",
    "intake_items",
    "conditions",
    "procedures",
    "imaging_studies",
    "immunizations",
    "optical_prescriptions",
    "dental_procedures",
    "illness_episodes",
  ]) {
    db.prepare(
      `UPDATE ${table} SET encounter_id = NULL
         WHERE profile_id = ?
           AND encounter_id IN (
             SELECT id FROM encounters WHERE profile_id = ? AND document_id = ?
           )`
    ).run(profileId, profileId, docId);
  }
  // Row-ops side-state (#1051/#1052): a medication (possibly from ANOTHER document, or
  // manual) may link a condition (indication_condition_id) THIS document produced — a
  // REFERENCES FK with no ON DELETE. NULL those back-links FIRST so deleting the
  // condition (in the footprint loop) can't trip the FK. The med survives, its
  // indication link honestly gone (a tier-1 link re-derives on its own reprocess).
  // (source_record_id was retired in #1178 — an imported prescription IS the med now,
  // never a paired medical_records row, so there is no prescription→med back-link.)
  db.prepare(
    `UPDATE intake_items SET indication_condition_id = NULL
       WHERE profile_id = ?
         AND indication_condition_id IN (
           SELECT id FROM conditions WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
  // (#1204 note: a CROSS-DOCUMENT renewal course this document contributed to a med
  // owned by ANOTHER document is NOT cleared here — a course is not document-keyed. It
  // is deduped on (item_id, started_on), so a reprocess re-adds nothing, and it is
  // cleaned via its parent med's CASCADE on med delete/merge — #1204's stated cleanup
  // model. A course on a med THIS document OWNS is cascade-deleted with the med below.)
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    db.prepare(
      `DELETE FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}`
    ).run(footprintKeyValue(t, docId, source), profileId);
  }
}

// The distinct vaccine strings a document's imported immunization rows currently
// carry — captured BEFORE a delete/reassign/reprocess un-backs them so the post-clear
// `immunization:<code>` dismissal sweep knows which codes may have lost their backing
// (#602). Keyed on the document's source string, the same predicate the footprint's
// immunizations table uses. Empty for a document that imported no immunizations.
export function documentImmunizationVaccines(
  profileId: number,
  docId: number
): string[] {
  const source = documentSource(docId);
  return (
    db
      .prepare(
        "SELECT DISTINCT vaccine FROM immunizations WHERE profile_id = ? AND source = ?"
      )
      .all(profileId, source) as { vaccine: string }[]
  ).map((r) => r.vaccine);
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
  // Row-ops side-state (#288): the appointment → encounter link must never cross
  // profiles. A reassign can move an encounter (or a linking appointment) but not
  // its counterpart — e.g. a MANUAL appointment stays in the source while its
  // imported encounter moves to the destination. Re-enforce the same-profile
  // invariant on BOTH affected profiles: NULL any appointment whose linked
  // encounter no longer lives in that appointment's profile. A link whose both
  // ends moved together (an imported appointment + its encounter from this doc)
  // stays intact, since the encounter now lives in the destination alongside it.
  for (const pid of [srcProfileId, destProfileId]) {
    db.prepare(
      `UPDATE appointments SET encounter_id = NULL
         WHERE profile_id = ? AND encounter_id IS NOT NULL
           AND encounter_id NOT IN (SELECT id FROM encounters WHERE profile_id = ?)`
    ).run(pid, pid);
  }
  // Row-ops side-state (#1050/#1053): the record/med/condition/procedure/imaging/
  // immunization/episode → encounter link must never cross profiles either. Same
  // re-enforce on BOTH affected profiles: NULL any encounter_id whose target visit no
  // longer lives in that row's profile (a link whose both ends moved together stays).
  for (const pid of [srcProfileId, destProfileId]) {
    for (const table of [
      "medical_records",
      "intake_items",
      "conditions",
      "procedures",
      "imaging_studies",
      "immunizations",
      "optical_prescriptions",
      "dental_procedures",
      "illness_episodes",
    ]) {
      db.prepare(
        `UPDATE ${table} SET encounter_id = NULL
           WHERE profile_id = ? AND encounter_id IS NOT NULL
             AND encounter_id NOT IN (SELECT id FROM encounters WHERE profile_id = ?)`
      ).run(pid, pid);
    }
  }
  // Row-ops side-state (#1052): a med's indication_condition_id (→ conditions) must
  // never cross profiles. A reassign can move a med but not a tier-2-linked condition
  // from another document (or vice-versa) — re-enforce same-profile on BOTH affected
  // profiles: NULL any link whose target no longer lives in that med's profile (a link
  // whose both ends moved together stays intact). (source_record_id was retired in
  // #1178 — an imported prescription IS the med now, no prescription→med back-link.)
  for (const pid of [srcProfileId, destProfileId]) {
    db.prepare(
      `UPDATE intake_items SET indication_condition_id = NULL
         WHERE profile_id = ? AND indication_condition_id IS NOT NULL
           AND indication_condition_id NOT IN (
             SELECT id FROM conditions WHERE profile_id = ?
           )`
    ).run(pid, pid);
  }
  // Row-ops side-state (#700): a follow-up's source/resolving imaging link must never
  // cross profiles. A reassign can move an imported imaging study but not a MANUAL
  // follow-up that links it (or vice-versa) — re-enforce same-profile on BOTH
  // affected profiles: NULL any care_plan_items link whose imaging study no longer
  // lives in that follow-up's profile (mirrors the appointment→encounter re-enforce).
  for (const pid of [srcProfileId, destProfileId]) {
    db.prepare(
      `UPDATE care_plan_items SET source_kind = NULL, source_imaging_study_id = NULL
         WHERE profile_id = ? AND source_imaging_study_id IS NOT NULL
           AND source_imaging_study_id NOT IN (
             SELECT id FROM imaging_studies WHERE profile_id = ?
           )`
    ).run(pid, pid);
    db.prepare(
      `UPDATE care_plan_items SET resolved_by_imaging_study_id = NULL
         WHERE profile_id = ? AND resolved_by_imaging_study_id IS NOT NULL
           AND resolved_by_imaging_study_id NOT IN (
             SELECT id FROM imaging_studies WHERE profile_id = ?
           )`
    ).run(pid, pid);
    // Row-ops side-state (#700 labs adapter): the same same-profile re-enforce for the
    // flagged-lab follow-up links — a reassign can move an imported reading but not a
    // MANUAL follow-up that links it (or vice-versa). NULL any care_plan_items link
    // whose medical_records source/resolving reading no longer lives in that follow-up's
    // profile.
    db.prepare(
      `UPDATE care_plan_items SET source_kind = NULL, source_medical_record_id = NULL
         WHERE profile_id = ? AND source_medical_record_id IS NOT NULL
           AND source_medical_record_id NOT IN (
             SELECT id FROM medical_records WHERE profile_id = ?
           )`
    ).run(pid, pid);
    db.prepare(
      `UPDATE care_plan_items SET resolved_by_medical_record_id = NULL
         WHERE profile_id = ? AND resolved_by_medical_record_id IS NOT NULL
           AND resolved_by_medical_record_id NOT IN (
             SELECT id FROM medical_records WHERE profile_id = ?
           )`
    ).run(pid, pid);
    // Row-ops side-state (#705 dental adapter): the same same-profile re-enforce for
    // the dental follow-up links — a reassign can move an imported dental record but
    // not a MANUAL follow-up that links it (or vice-versa).
    db.prepare(
      `UPDATE care_plan_items SET source_kind = NULL, source_dental_procedure_id = NULL
         WHERE profile_id = ? AND source_dental_procedure_id IS NOT NULL
           AND source_dental_procedure_id NOT IN (
             SELECT id FROM dental_procedures WHERE profile_id = ?
           )`
    ).run(pid, pid);
    db.prepare(
      `UPDATE care_plan_items SET resolved_by_dental_procedure_id = NULL
         WHERE profile_id = ? AND resolved_by_dental_procedure_id IS NOT NULL
           AND resolved_by_dental_procedure_id NOT IN (
             SELECT id FROM dental_procedures WHERE profile_id = ?
           )`
    ).run(pid, pid);
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

// Close the appointment → encounter loop for a just-imported document (issue
// #288): when this document landed encounters that correspond to still-scheduled
// appointments the user booked ahead of the visit, mark those appointments
// completed and link them — the "zero manual steps" half of the preventive loop.
// Runs inside persistDocumentImport's transaction, AFTER the encounter INSERTs, so
// it sees exactly the rows this import wrote.
//
// The match decision is the pure, conservative matchAppointmentForEncounter (a
// null provider on either side never matches; two same-day candidates need a clear
// nearest-time signal or it declines). Every read/write is profile-scoped. Each
// encounter re-reads the still-scheduled, still-unlinked appointment set, so an
// appointment consumed by an earlier encounter in the same batch can't be matched
// twice. When the completed appointment's kind maps to a single preventive rule
// (physical/dental/vision), the satisfaction is ALSO recorded (dated the visit) via
// the SAME recordPreventiveDone stream the manual close-the-loop uses — so the rule
// is satisfied end-to-end without a click, mirroring recordPreventiveFromAppointment.
export function autoCompleteAppointmentsFromEncounters(
  profileId: number,
  docId: number
): void {
  const encounters = db
    .prepare(
      `SELECT id, date, provider_id AS providerId
         FROM encounters
        WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    id: number;
    date: string;
    providerId: number | null;
  }[];
  if (encounters.length === 0) return;

  const readScheduled = db.prepare(
    `SELECT id, scheduled_at AS scheduledAt, provider_id AS providerId,
            status, encounter_id AS encounterId, kind
       FROM appointments
      WHERE profile_id = ? AND status = 'scheduled' AND encounter_id IS NULL`
  );
  const completeAndLink = db.prepare(
    `UPDATE appointments
        SET status = 'completed', encounter_id = ?
      WHERE id = ? AND profile_id = ? AND status = 'scheduled'
        AND encounter_id IS NULL`
  );

  for (const enc of encounters) {
    const candidates = readScheduled.all(profileId) as {
      id: number;
      scheduledAt: string;
      providerId: number | null;
      status: string;
      encounterId: number | null;
      kind: string | null;
    }[];
    const matchId = matchAppointmentForEncounter(
      { date: enc.date, providerId: enc.providerId },
      candidates
    );
    if (matchId == null) continue;
    completeAndLink.run(enc.id, matchId, profileId);
    // Close the preventive loop when the completed appointment's kind maps to a
    // single rule — same satisfaction stream as the manual "Mark done" offer.
    const matched = candidates.find((c) => c.id === matchId);
    const ruleKey = satisfiedRuleForCompletedKind(matched?.kind ?? null);
    if (ruleKey) {
      recordPreventiveDone(
        profileId,
        ruleKey,
        enc.date.slice(0, 10),
        "appointment"
      );
    }
  }
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
  const providerIdFor = buildProviderResolver(input.providers);

  const result = writeTx(() => {
    // Capture the vaccine codes THIS document currently backs BEFORE the clear, so
    // the post-insert sweep can clear an `immunization:<code>` dismissal whose last
    // backing dose a re-extraction drops (#602). Empty on a first import (the doc has
    // no prior immunization rows), so the sweep no-ops there.
    const priorVaccines = documentImmunizationVaccines(profileId, docId);
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

    const counts = insertImportRows(profileId, docId, input, providerIdFor);

    // Sweep any `immunization:<code>` due-nudge dismissal whose backing this reprocess
    // just dropped (a re-extraction that no longer contains a previously-imported
    // dose), so a later re-add re-surfaces the nudge instead of hitting a stale
    // suppression (#602/#203). Reads the post-insert remaining doses, so a vaccine the
    // re-extraction re-inserted keeps its dismissal; a no-op when nothing was un-backed.
    sweepImmunizationDismissals(profileId, priorVaccines);

    // Close the appointment → encounter loop: a just-imported encounter that
    // matches a still-scheduled appointment marks it completed + linked (#288).
    autoCompleteAppointmentsFromEncounters(profileId, docId);

    // Re-apply the user's durable tier-2 visit-link decisions (#1050/#1053): a
    // reprocess deleted-and-reinserted this document's rows under new ids but the
    // SAME external_ids, so a previously-accepted link is restored (and a dead
    // decision swept). Tier-1 FHIR links already self-healed above at insert.
    reapplyVisitLinkDecisions(profileId);

    // The toast + Review feed report ONE "N items imported" number. Tally it off
    // the footprint tables here — after every insert loop — so it counts every
    // clinical kind an import wrote, not just the immunizations + records the old
    // `immCount + recCount` saw (#212).
    const extractedCount = countImportedDocumentRows(profileId, docId);
    // `extraction_completed_at` (issue #1022): the moment this document became
    // 'done' — the digest's "new documents" window keys on it (a doc can complete
    // long after `uploaded_at`: the upload/digest race, a failed→reprocessed doc).
    // This UPDATE is the ONE 'done' transition (every extract/import/reprocess
    // path funnels through persistDocumentImport), so the stamp can't be missed;
    // a reprocess re-stamps it, which is correct — the re-extraction is news.
    db.prepare(
      `UPDATE medical_documents
         SET extraction_status = 'done', extraction_completed_at = datetime('now'),
             extracted_count = ?, doc_type = ?,
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
    return { counts, extractedCount };
  });

  // This document's rows just changed — drop any cached reprocess-preview input for
  // it (#946) so a stale preview can't be applied over the fresh import. The token's
  // staleness key is the correctness guard; this is the eviction the issue asks for
  // at the persist chokepoint every import/reprocess path funnels through.
  evictPreviewsForDocument(profileId, docId);

  return {
    immCount: result.counts.immCount,
    recCount: result.counts.recCount,
    extractedCount: result.extractedCount,
    insertedRecordIds: result.counts.insertedRecordIds,
  };
}

// The rows a documentless import (the /data paste/CSV commit) wrote. There is NO
// document row — so the counts are returned directly (not tallied off a document's
// footprint), and the rows carry NO document_id / a NULL-or-'manual' source, which
// is exactly why they're EXEMPT from the import-footprint contract
// (clearImportedDocumentRows / moveImportedDocumentRows / countImportedDocumentRows
// all key off a docId this import doesn't have). See persistDocumentlessImport.
export interface DocumentlessOutcome {
  recCount: number;
  immCount: number;
  medCount: number;
  bodyMetricCount: number;
  heightCount: number;
  headCircCount: number;
  insertedRecordIds: number[];
}

// Persist a paste/CSV import — the SAME extraction output a file upload produces,
// but with no stored document behind it. It runs the IDENTICAL projection +
// insert loops as persistDocumentImport (body-metric routing, height/head-circ →
// metric_samples, prescription → structured intake_items), so a pasted reading
// reaches the weight charts / growth card / medication list exactly like an
// uploaded one did — closing the "same text, two outcomes" gap (#418).
//
// Footprint contract: a documentless import is DELIBERATELY exempt from the
// clear/reassign/tally footprint helpers. With no document id its rows carry a
// NULL document_id and a NULL (medical_records/body_metrics/immunizations) or
// 'manual' (height/head-circ metric_samples) source — indistinguishable from a
// hand-entered row, and therefore never touched by a document delete/reassign,
// by design. There is nothing to delete or reassign because there is no document.
export function persistDocumentlessImport(
  profileId: number,
  input: PersistInput
): DocumentlessOutcome {
  const providerIdFor = buildProviderResolver(input.providers);
  const counts = writeTx(() =>
    insertImportRows(profileId, null, input, providerIdFor)
  );
  return {
    recCount: counts.recCount,
    immCount: counts.immCount,
    medCount: counts.medCount,
    bodyMetricCount: counts.bodyMetricCount,
    heightCount: counts.heightCount,
    headCircCount: counts.headCircCount,
    insertedRecordIds: counts.insertedRecordIds,
  };
}

// Resolve every captured provider (per-record/immunization performers + the
// section-level Care Teams) into the shared GLOBAL registry, memoized by dedup
// key so one INSERT per distinct provider. Done up front, outside the
// per-document transaction, because the providers table is global and its
// resolve-or-create is independently idempotent — a reprocess re-resolves to the
// same rows and never coins a duplicate. Returns the shared row id to stamp onto
// the profile-owned immunization/record row's provider_id. Shared by both the
// document and the documentless import paths.
function buildProviderResolver(
  seed: ImportedProvider[]
): (p: ImportedProvider | null | undefined) => number | null {
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
  for (const p of seed) providerIdFor(p);
  return providerIdFor;
}

// Per-kind counts of what an import's insert loops actually wrote (deferred /
// deduped rows aren't counted). The document path folds these into the footprint
// tally; the documentless path returns them directly for its toast.
interface ImportInsertCounts {
  immCount: number;
  recCount: number;
  medCount: number;
  bodyMetricCount: number;
  heightCount: number;
  headCircCount: number;
  insertedRecordIds: number[];
}

// THE shared insert loops — every table an import writes, run identically by the
// document path (docId set) and the documentless paste path (docId null). MUST run
// inside a transaction the caller opens (so a document import can clear + finalize
// around it, and both roll back atomically). `docId` null routes rows as
// documentless: NULL document_id, NULL record/immunization/body_metric source, and
// a 'manual' metric_samples source (matching the manual growth writer), so pasted
// rows are indistinguishable from hand-entered ones.
function insertImportRows(
  profileId: number,
  docId: number | null,
  input: PersistInput,
  providerIdFor: (p: ImportedProvider | null | undefined) => number | null
): ImportInsertCounts {
  // A document import stamps document_id + source='document:<id>'; a documentless
  // (paste) import stamps NULL for the record/immunization/body-metric source and
  // 'manual' for the height/head-circ metric_samples source (the metric_samples
  // source column is NOT NULL-conventioned — its manual provenance is the literal
  // 'manual', per the growth writer).
  const docSource = docId != null ? documentSource(docId) : null;
  const sampleSource = docSource ?? "manual";

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
  // A documentless import (no docSource) has no external_id dedup to scope — its
  // rows are manual-like — so it always stores NULL, matching the paste path's
  // prior direct inserts.
  const scopedExternalId = (raw: string | null): string | null =>
    raw == null || docSource == null ? null : `${docSource}|${raw}`;

  // One insert covers every record type (lab / vital / prescription / …).
  // external_id is nullable — the deterministic path sets it (dedup via the
  // per-profile partial-unique index); the AI path leaves it null and relies on
  // the delete-by-document_id above.
  const insRec = db.prepare(
    `INSERT OR IGNORE INTO medical_records
       (date, category, name, value, value_num, unit, reference_range, notes,
        panel, flag, canonical_name, document_id, source, external_id, provider_id,
        profile_id, loinc)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
       (date, end_date, type, code, code_system, class_code, reason, diagnoses,
        notes, provider_id, location_provider_id, source, document_id,
        external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
  // Genomic variants (#709). Same idempotency as the other clinical domains: the
  // per-document delete-set clears this document's prior rows, then INSERT OR IGNORE
  // dedups within the document via the per-profile unique external_id index (scoped
  // with the document source). Keyed to the document via document_id so the import
  // footprint clears/moves/counts it, exactly like conditions/procedures.
  const insGenomicVariant = db.prepare(
    `INSERT OR IGNORE INTO genomic_variants
       (gene, variant, genotype, star_allele, zygosity, significance,
        result_type, interpretation, source_lab, report_date,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Imaging studies (#702). Same idempotency as the other clinical domains: the
  // per-document delete-set clears this document's prior rows, then INSERT OR IGNORE
  // dedups within the document via the per-profile unique external_id index (scoped
  // with the document source). Keyed to the document via document_id so the import
  // footprint clears/moves/counts it, exactly like conditions/procedures.
  const insImagingStudy = db.prepare(
    `INSERT OR IGNORE INTO imaging_studies
       (modality, body_region, laterality, contrast, contrast_agent, study_date,
        dose_msv, impression, indication, status,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Optical prescriptions (#697). Same idempotency as the other clinical domains:
  // the per-document delete-set clears this document's prior rows, then INSERT OR
  // IGNORE re-inserts. Keyed to the document via document_id so the import footprint
  // clears/moves/counts it, exactly like conditions/imaging_studies. provider_id is
  // the resolved shared-registry id for the prescribing optometrist.
  const insOpticalPrescription = db.prepare(
    `INSERT OR IGNORE INTO optical_prescriptions
       (kind, od_sphere, od_cylinder, od_axis, od_add,
        os_sphere, os_cylinder, os_axis, os_add,
        pd, base_curve, diameter, brand, issued_date, expiry_date,
        provider_id, notes, source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Dental procedures (#705). Same idempotency shape as the other clinical domains:
  // the per-document delete-set clears this document's prior rows, then the insert
  // re-adds them. Keyed to the document via document_id so the import footprint
  // clears/moves/counts it, exactly like imaging_studies.
  const insDentalProcedure = db.prepare(
    `INSERT OR IGNORE INTO dental_procedures
       (name, status, tooth, tooth_system, surface, cdt_code, procedure_date,
        finding, follow_up_interval_days,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Scheduled appointments (issue #416). Same idempotency as the other clinical
  // domains: the per-document delete-set clears this document's prior rows, then
  // INSERT OR IGNORE dedups within the document via the per-profile unique external_id
  // index (scoped with the document source). provider_id is the resolved shared-
  // registry id for the attending clinician; location is a plain facility string.
  const insAppointment = db.prepare(
    `INSERT OR IGNORE INTO appointments
       (scheduled_at, provider_id, title, location, notes, kind, status,
        source, document_id, external_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  // Structured medications (#1178): an imported prescription is the SINGLE
  // medication entity — a kind='medication' intake_items row (source='extracted',
  // document_id), never a paired medical_records prescription. `import_key` is the
  // stable within-document reprocess key (`medimport:<docId>|<lower(name)>`) the
  // med's visit-link decisions anchor on. A cross-document re-prescription of an
  // existing med attaches as a new COURSE instead (#1204), not a duplicate item.
  //
  // Existing medications (manual OR from another document) the profile already has,
  // with their lifecycle + known-strength state — read AFTER this document's own
  // extracted meds are cleared, so a reprocess doesn't see its own prior rows. A
  // matching drug renews (course) or, for the #1027 concurrent-different-strength
  // case, spawns a separate item. Matched on the cleaned/grouping name (RxCUI-first
  // when both carry a code, #482/#1026).
  const insMed = db.prepare(
    `INSERT INTO intake_items
       (name, notes, active, condition, priority, kind,
        prescriber, pharmacy, rx_number, as_needed,
        document_id, source, provider_id, import_key, profile_id)
     VALUES (?,?,1,'daily','high','medication',?,?,?,?,?,'extracted',?,?,?)`
  );
  const insMedDose = db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?,?,?, 'any', ?)`
  );

  const insertedRecordIds: number[] = [];
  let immCount = 0;
  let recCount = 0;
  let bodyMetricCount = 0;
  let heightCount = 0;
  let headCircCount = 0;

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
  // An import defers to existing body-metrics rows on the same date (manual,
  // integration, or another document) so a retrospective scan can't stack a
  // duplicate point or outrank a manual entry — but only per measure: an
  // import's weight for a date that only has an integration resting-HR row is
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
    bodyMetricCount++;
  }
  // Body-height samples → metric_samples. Defer a date another source
  // already covers (never overwrite manual/integration/another-document height),
  // else insert a point sample keyed by the date. heightsFromReadings already
  // reduced to one plausible value per date.
  for (const h of input.heights) {
    if (heightCovered.get(profileId, h.date)) continue;
    const info = insHeight.run(
      profileId,
      sampleSource,
      h.date,
      h.date,
      h.date,
      h.height_cm
    );
    if (info.changes > 0) heightCount++;
  }
  // Head-circumference samples → metric_samples, same defer-then-insert
  // rule as height: never overwrite a date another source already covers.
  for (const h of input.headCircs) {
    if (headCircCovered.get(profileId, h.date)) continue;
    const info = insHeadCirc.run(
      profileId,
      sampleSource,
      h.date,
      h.date,
      h.date,
      h.head_circumference_cm
    );
    if (info.changes > 0) headCircCount++;
  }
  for (const r of input.records) {
    // #1178: a prescription is the SINGLE medication entity (projected into
    // intake_items by persistExtractedMedications below), never a paired
    // medical_records row — so it is NOT inserted here. Every other category (lab /
    // vital / scan / …) is a medical_records reading as before.
    if (r.category === "prescription") continue;
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
      profileId,
      r.loinc ?? null
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
      e.code ?? null,
      e.code_system ?? null,
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
  // Genomic variants (#709) — optional on PersistInput, so guard with `?? []` for a
  // fixture / deterministic-path input that carries none.
  for (const v of input.genomicVariants ?? []) {
    insGenomicVariant.run(
      v.gene,
      v.variant,
      v.genotype,
      v.star_allele,
      v.zygosity,
      v.significance,
      v.result_type,
      v.interpretation,
      v.source_lab,
      v.report_date,
      docSource,
      docId,
      scopedExternalId(v.external_id),
      profileId
    );
  }
  // Imaging studies (#702) — optional on PersistInput, so guard with `?? []` for a
  // fixture / deterministic-path input that carries none. `contrast` is stored 0/1.
  for (const s of input.imagingStudies ?? []) {
    insImagingStudy.run(
      s.modality,
      s.body_region,
      s.laterality,
      s.contrast ? 1 : 0,
      s.contrast_agent,
      s.study_date,
      s.dose_msv,
      s.impression,
      s.indication,
      s.status,
      docSource,
      docId,
      scopedExternalId(s.external_id),
      profileId
    );
  }
  // Optical prescriptions (#697) — optional on PersistInput, so guard with `?? []`.
  // The prescriber name resolves into the shared providers registry via providerIdFor.
  for (const p of input.opticalPrescriptions ?? []) {
    insOpticalPrescription.run(
      p.kind,
      p.od_sphere,
      p.od_cylinder,
      p.od_axis,
      p.od_add,
      p.os_sphere,
      p.os_cylinder,
      p.os_axis,
      p.os_add,
      p.pd,
      p.base_curve,
      p.diameter,
      p.brand,
      p.issued_date,
      p.expiry_date,
      providerIdFor(p.provider),
      p.notes,
      docSource,
      docId,
      scopedExternalId(p.external_id),
      profileId
    );
  }
  // Dental procedures (#705) — optional on PersistInput, so guard with `?? []`.
  for (const d of input.dentalProcedures ?? []) {
    insDentalProcedure.run(
      d.name,
      d.status,
      d.tooth,
      d.tooth_system,
      d.surface,
      d.cdt_code,
      d.procedure_date,
      d.finding,
      d.follow_up_interval_days,
      docSource,
      docId,
      scopedExternalId(d.external_id),
      profileId
    );
  }
  for (const a of input.appointments) {
    insAppointment.run(
      a.scheduled_at,
      providerIdFor(a.provider),
      a.title,
      a.location,
      a.notes,
      a.kind,
      a.status,
      docSource,
      docId,
      scopedExternalId(a.external_id),
      profileId
    );
  }
  // Tier-1 VISIT LINKS (#1050): resolve each FHIR encounter reference (recovered by
  // the mappers as `encounter_external_id`) to the local encounter row just inserted,
  // and stamp encounter_id on the linked record. Deterministic + free — re-derived
  // every import, so it self-heals on reprocess. Only the document path carries
  // encounter references (the paste/AI path leaves them null), so guard on docSource.
  const resolveEnc = makeEncounterResolver(profileId, docSource);
  const resolveCondition = makeConditionResolver(profileId, docSource);
  if (docSource) {
    linkRowsByExternalId(
      profileId,
      docSource,
      "medical_records",
      input.records,
      resolveEnc
    );
    linkRowsByExternalId(
      profileId,
      docSource,
      "conditions",
      input.conditions,
      resolveEnc
    );
    linkRowsByExternalId(
      profileId,
      docSource,
      "procedures",
      input.procedures,
      resolveEnc
    );
    linkRowsByExternalId(
      profileId,
      docSource,
      "immunizations",
      input.immunizations,
      resolveEnc
    );
  }

  // Project each prescription into the SINGLE medication entity (#1178). A group
  // whose cleaned/grouping name matches an existing med (manual or another
  // document's) attaches as a new COURSE (#1204 renewal) rather than a duplicate
  // item — except the #1027 concurrent-different-strength case, which stays a
  // separate item. A repeated prescription within one document collapses into one
  // med carrying the union of its courses.
  const medCount = persistExtractedMedications(
    profileId,
    docId,
    input.records,
    {
      existing: getMedMatchStates(profileId),
      insMed,
      insMedDose,
      // Tier-1: the med projected from a prescription that named an encounter is
      // stamped with the resolved local encounter id at INSERT (#1050).
      resolveEnc: docSource ? resolveEnc : undefined,
      // Tier-1 indication (#1052): a prescription that named a reason Condition
      // stamps the projected med's indication_condition_id.
      resolveCondition: docSource ? resolveCondition : undefined,
    }
  );

  return {
    immCount,
    recCount,
    medCount,
    bodyMetricCount,
    heightCount,
    headCircCount,
    insertedRecordIds,
  };
}

type Stmt = Database.Statement;

// Tier-1 visit link (#1050): a memoized resolver from a RAW encounter external_id
// (`ccda:encounter:<id>`, as the mappers emit it) to the local encounter row id. An
// imported encounter is stored under the SCOPED external_id `<docSource>|<raw>`, so
// the lookup re-scopes before querying — stable across reprocess of the same
// document. Returns null when the reference dangles (never a wrong link).
export function makeEncounterResolver(
  profileId: number,
  docSource: string | null
): (raw: string | null | undefined) => number | null {
  const cache = new Map<string, number | null>();
  return (raw) => {
    if (!raw || !docSource) return null;
    if (cache.has(raw)) return cache.get(raw)!;
    const row = db
      .prepare(
        `SELECT id FROM encounters WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, `${docSource}|${raw}`) as { id: number } | undefined;
    const id = row ? row.id : null;
    cache.set(raw, id);
    return id;
  };
}

// Tier-1 indication link (#1052): a memoized resolver from a RAW condition external_id
// (`ccda:condition:...`, as mapConditionResource emits it) to the local condition row
// id. Imported conditions are stored under the SCOPED external_id `<docSource>|<raw>`
// (the same scoping the encounter resolver uses), so the lookup re-scopes before
// querying — stable across reprocess. Returns null when the reference dangles.
export function makeConditionResolver(
  profileId: number,
  docSource: string | null
): (raw: string | null | undefined) => number | null {
  const cache = new Map<string, number | null>();
  return (raw) => {
    if (!raw || !docSource) return null;
    if (cache.has(raw)) return cache.get(raw)!;
    const row = db
      .prepare(
        `SELECT id FROM conditions WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, `${docSource}|${raw}`) as { id: number } | undefined;
    const id = row ? row.id : null;
    cache.set(raw, id);
    return id;
  };
}

// Stamp encounter_id on each row of `rows` (a table whose stored external_id is the
// scoped `<docSource>|<raw>`) whose `encounter_external_id` resolves to a local
// encounter. Only sets a currently-null link (a manual re-link is never clobbered).
function linkRowsByExternalId(
  profileId: number,
  docSource: string,
  table: string,
  rows: { external_id: string | null; encounter_external_id?: string | null }[],
  resolveEnc: (raw: string | null | undefined) => number | null
): void {
  const stmt = db.prepare(
    `UPDATE ${table} SET encounter_id = ?
      WHERE profile_id = ? AND external_id = ? AND encounter_id IS NULL`
  );
  for (const r of rows) {
    if (!r.encounter_external_id || !r.external_id) continue;
    const encId = resolveEnc(r.encounter_external_id);
    if (encId == null) continue;
    stmt.run(encId, profileId, `${docSource}|${r.external_id}`);
  }
}

// A descriptive dose/sig SNAPSHOT for a course (#1204 Model X): the strength + the
// parsed directions as prescribed at this course. Null when the source carried
// neither. The live reminder schedule stays item-keyed on intake_item_doses; this is
// the historical record of what was prescribed, so a renewal at a new strength is
// preserved even though the live schedule is not silently overwritten.
function doseSnapshotOf(
  med: ReturnType<typeof parsePrescription>
): string | null {
  const parts = [med.strength, med.sig].filter((p): p is string => !!p);
  return parts.length ? parts.join(" — ") : null;
}

// The stable within-document import key a projected medication carries (#1178): a
// reprocess deletes-and-reinserts the med under a new id but the SAME import_key, so
// its accepted tier-2 visit-link decision re-applies. NULL for a documentless (paste)
// med, whose stable id suffices. Mirrors migration 092's backfill expression.
function medImportKey(
  docId: number | null,
  cleanedName: string
): string | null {
  return docId != null
    ? `medimport:${docId}|${cleanedName.toLowerCase()}`
    : null;
}

// Project an import's prescriptions into the SINGLE medication entity (#1178):
// kind='medication' intake_items rows (+ dose rows + courses), never a paired
// medical_records prescription. Runs inside insertImportRows' caller transaction;
// for a document import, after this document's prior extracted meds were cleared.
// `docId` is null for a documentless (paste) import. Returns the count of NEW
// medication ITEMS created (a renewal course on an existing med is not a new item).
//
// Cross-document / repeat handling (#1204):
//   - A repeat of the SAME drug WITHIN this document collapses into ONE med carrying
//     the union of its derived courses (the first occurrence's parse wins).
//   - A drug whose cleaned/grouping name MATCHES an existing med (manual or another
//     document's) attaches as a new COURSE on that med (renewal semantics) — its
//     period + prescriber + dose snapshot — INSTEAD of the old skip-to-records-
//     fallback. The one exception is the #1027 concurrent-different-strength case
//     (the existing med has an OPEN course at a PROVABLY DIFFERENT strength), which
//     stays a SEPARATE item.
//
// Scheduling is conservative (see prescription-parse): a clear sig becomes scheduled
// doses; an unparseable one becomes an as-needed med (never scheduled-due) rather
// than a fabricated daily reminder.
function persistExtractedMedications(
  profileId: number,
  docId: number | null,
  records: PersistRecord[],
  ctx: {
    existing: MedMatchState[];
    insMed: Stmt;
    insMedDose: Stmt;
    // Tier-1 (#1050): resolve the prescription's encounter reference to a local
    // encounter row id, stamped onto the projected med. Absent → no linking.
    resolveEnc?: (raw: string | null | undefined) => number | null;
    // Tier-1 indication (#1052): resolve the prescription's reason (condition)
    // reference to a local condition row id, stamped onto the projected med.
    resolveCondition?: (raw: string | null | undefined) => number | null;
  }
): number {
  const prescriptions = records.filter((r) => r.category === "prescription");
  if (prescriptions.length === 0) return 0;

  // Group prescriptions by cleaned drug name so repeated prescriptions — or several
  // MedicationStatements for one drug at different periods — collapse into ONE unit
  // carrying the UNION of their derived courses. The FIRST occurrence's parse (sig /
  // strength / schedule) wins; later ones only contribute courses + the earliest
  // prescribed date.
  const groups = new Map<
    string,
    {
      med: ReturnType<typeof parsePrescription>;
      courses: ImportedMedicationCourse[];
      encExt: string | null;
      indExt: string | null;
      // The earliest prescribed date across the grouped records — the fallback
      // course start when the source carried no explicit effective period.
      presDate: string | null;
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
      // Structured attribution the CCD/FHIR mappers resolved — wins over the
      // free-text scrape so an imported med carries its real prescriber/pharmacy/
      // Rx number instead of NULL (#417).
      prescriber: r.prescriber ?? null,
      pharmacy: r.pharmacy ?? null,
      rxNumber: r.rxNumber ?? null,
    });
    const key = med.name.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = {
        med,
        courses: [],
        encExt: r.encounter_external_id ?? null,
        indExt: r.indication_condition_external_id ?? null,
        presDate: r.date ?? null,
      };
      groups.set(key, g);
      order.push(key);
    }
    if (!g.encExt && r.encounter_external_id)
      g.encExt = r.encounter_external_id;
    if (!g.indExt && r.indication_condition_external_id)
      g.indExt = r.indication_condition_external_id;
    if (r.date && (!g.presDate || r.date < g.presDate)) g.presDate = r.date;
    if (r.courses && r.courses.length) g.courses.push(...r.courses);
  }

  // Find an existing tracked med this parsed prescription matches — the SAME
  // cleaned/grouping-name identity the #1027 duplication family + the records bridge
  // key on (medNameKey), RxCUI-first when both sides carry a code (#482/#1026).
  const matchExisting = (
    med: ReturnType<typeof parsePrescription>
  ): MedMatchState | null => {
    const key = medNameKey(med.name);
    for (const ex of ctx.existing) {
      const exKeys = new Set([medNameKey(ex.name)]);
      if (ex.brand) exKeys.add(medNameKey(ex.brand));
      if (key && exKeys.has(key)) return ex;
    }
    // The RxCUI-first path stays open for a future import that captures a code on the
    // prescription (records carry none today), so the cleaned name is the working
    // signal — the SAME grouping medNameKey the #1027 duplication family + the records
    // bridge use, so the identity can't diverge across surfaces (#482).
    return null;
  };

  let newItems = 0;
  for (const key of order) {
    const { med, courses, encExt, indExt, presDate } = groups.get(key)!;
    // Prescriber link (#1051 semantics (a)): resolve the parsed prescriber TEXT into
    // an EXISTING individual registry row (exact only — never an org / near-miss).
    const providerId = med.prescriber
      ? resolveExactPrescriberId(med.prescriber)
      : null;
    const attribution: CourseAttribution = {
      prescriber: med.prescriber,
      providerId,
      doseSnapshot: doseSnapshotOf(med),
    };

    // Cross-document / cross-provider re-prescription (#1204): does this drug match a
    // med the profile already tracks? If so, renew (course) unless the #1027
    // concurrent-different-strength case dictates a separate item.
    const existing = matchExisting(med);
    if (existing) {
      const newStrength = med.strength ?? strengthFromName(med.name);
      const relationship = classifyReprescription({
        existingHasOpenCourse: existing.hasOpenCourse,
        existingStrengths: new Set(
          existing.strengths
            .map((s) => normalizeStrength(s))
            .filter((s): s is string => !!s)
        ),
        newStrength,
      });
      if (relationship === "renewal") {
        // Attach the renewal's course(s) to the existing med. Explicit source
        // period(s) win; otherwise a single course dated the prescribed date. The
        // dose snapshot rides the attribution so a dose change is preserved in
        // history (the live schedule is not overwritten — Model X, #1204).
        if (courses.length > 0) {
          for (const c of courses) {
            addRenewalCourse(profileId, existing.id, {
              startedOn: c.started_on,
              stoppedOn: c.stopped_on,
              stopReason: c.stop_reason,
              notes: c.notes,
              attribution,
            });
          }
        } else {
          addRenewalCourse(profileId, existing.id, {
            startedOn: presDate,
            attribution,
          });
        }
        continue; // no new item — the existing med carries this prescription
      }
      // "separate" falls through: project a distinct item (#1027 concurrent).
    }

    const info = ctx.insMed.run(
      med.name,
      med.sig, // directions kept as the row's notes (may be null)
      med.prescriber,
      med.pharmacy,
      med.rxNumber,
      med.asNeeded ? 1 : 0,
      // document_id — traces the row back to its source document for the delete-set.
      docId,
      providerId,
      // import_key — the stable within-doc reprocess anchor for visit-link decisions.
      medImportKey(docId, med.name),
      profileId
    );
    const medId = Number(info.lastInsertRowid);
    newItems++;

    // Tier-1 visit link (#1050): stamp the resolved encounter id onto the med.
    if (ctx.resolveEnc && encExt) {
      const encId = ctx.resolveEnc(encExt);
      if (encId != null) {
        db.prepare(
          `UPDATE intake_items SET encounter_id = ? WHERE id = ? AND profile_id = ?`
        ).run(encId, medId, profileId);
      }
    }

    // Tier-1 indication link (#1052): stamp the resolved condition id onto the med.
    if (ctx.resolveCondition && indExt) {
      const condId = ctx.resolveCondition(indExt);
      if (condId != null) {
        db.prepare(
          `UPDATE intake_items SET indication_condition_id = ? WHERE id = ? AND profile_id = ?`
        ).run(condId, medId, profileId);
      }
    }

    // Courses: explicit source period(s) → one course per DERIVED course; otherwise
    // a single open initial course. Both carry the prescriber + dose snapshot + source
    // document. Idempotent — a reprocess first deletes the med, cascading its courses.
    if (courses.length > 0) {
      createImportedMedicationCourses(profileId, medId, courses, attribution);
    } else {
      ensureMedicationCourse(profileId, medId, null, false, attribution);
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
  return newItems;
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
    // The document's readings, so a blood type can be adopted off a lab row — it is
    // not document metadata like sex/birthdate, so it can't ride `demographics`.
    // Optional: a caller with nothing to offer just adopts no blood type.
    records?: PersistInput["records"];
  }
): ProfileAdoption {
  const adopted = adoptProfileFromExtraction(profileId, opts.demographics);
  // Blood type rides the same adopt-if-unset seam as the demographics above, so both
  // import paths behave identically.
  adopted.bloodType = adoptBloodTypeFromRecords(profileId, opts.records);
  if (adopted.bloodType) adopted.changed = true;
  addCanonicalNames(opts.canonicalNames);
  if (adopted.sexAdopted) reconcileFlags(profileId);
  else reconcileFlags(profileId, opts.insertedRecordIds);
  return adopted;
}
