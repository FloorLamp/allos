import { db, writeTx } from "./db";
import { sqlNow } from "./clock";
import { documentSource, undeferredBodyMetrics } from "./body-metric-extract";
import { adoptSmokingStatusFromImport } from "./settings";
import { smokingStatusToStructured } from "./social-history";
import {
  getMedMatchStates,
  sweepImmunizationDismissals,
  reapplyVisitLinkDecisions,
} from "./queries";
import { resolveProviderId } from "./providers-db";
import { cleanProviderInput, providerDedupKey } from "./providers";
import type { ImportedProvider } from "./health-import";
import type { PersistInput } from "./import-shape";
import {
  normalizeResultStatus,
  parseFasting,
  sanitizeSpecimen,
} from "./lab-result-lifecycle";
import { evictPreviewsForDocument } from "./reprocess-preview-cache";
import { clinicalKeyForInput } from "./clinical-content-key";
export {
  applyImportFollowups,
  type ImportFollowupOptions,
} from "./import-persist/followups";
export {
  makeConditionResolver,
  makeEncounterResolver,
} from "./import-persist/link-resolvers";
import {
  makeConditionResolver,
  makeEncounterResolver,
} from "./import-persist/link-resolvers";
export { autoCompleteAppointmentsFromEncounters } from "./import-persist/appointments";
import { autoCompleteAppointmentsFromEncounters } from "./import-persist/appointments";
import { persistExtractedMedications } from "./import-persist/medications";

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
    // #1526: skin_lesions + allergies carry encounter_id too now (migration 125). A
    // MANUAL lesion or allergy tier-2 linked to a visit THIS document produced has the
    // same dangling-FK hazard as its siblings, so it must be freed here as well.
    "skin_lesions",
    "allergies",
  ]) {
    db.prepare(
      `UPDATE ${table} SET encounter_id = NULL
         WHERE profile_id = ?
           AND encounter_id IN (
             SELECT id FROM encounters WHERE profile_id = ? AND document_id = ?
           )`
    ).run(profileId, profileId, docId);
  }
  // Episode ↔ visit is a link table now (#1198), not an FK column: delete the link rows
  // for any encounter THIS document produced so the encounter delete can't trip the FK.
  // The durable 'linked' decision survives (its encounter token re-resolves on reprocess
  // and re-inserts the link via reapplyVisitLinkDecisions), mirroring the record tables.
  db.prepare(
    `DELETE FROM episode_encounters
       WHERE profile_id = ?
         AND encounter_id IN (
           SELECT id FROM encounters WHERE profile_id = ? AND document_id = ?
         )`
  ).run(profileId, profileId, docId);
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
  // Row-ops side-state (#1808): a protocol may adopt an intake_items med as its
  // intervention (protocols.intake_item_id, #660 — a REFERENCES FK with no ON DELETE),
  // and that med can be one THIS document extracted. NULL those links FIRST so the
  // intake_items delete (in the footprint loop) can't trip the FK. The protocol survives
  // under its own name with no intervention linked — the same degradation the manual med
  // delete already chose (lib/undo-delete-db.ts).
  // (episode_stopped_meds needs no statement here: migration 137 gave its item_id and
  // course_id ON DELETE SET NULL, so the record survives its med by name — the
  // "episode-stopped-med-link" entry in IMPORT_SIDE_EFFECTS declares that.)
  db.prepare(
    `UPDATE protocols SET intake_item_id = NULL
       WHERE profile_id = ?
         AND intake_item_id IN (
           SELECT id FROM intake_items
            WHERE profile_id = ? AND document_id = ? AND source = 'extracted'
         )`
  ).run(profileId, profileId, docId);
  for (const t of IMPORT_FOOTPRINT_TABLES) {
    // Name the table in the failure. A constraint thrown from inside this loop used to
    // surface as a bare SQLITE_CONSTRAINT_FOREIGNKEY, and finding out WHICH of eighteen
    // deletes was refused — and by which referencing row — was a foreign-key walk by
    // hand (#1808). The loop already knows the table; say so.
    try {
      db.prepare(
        `DELETE FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}`
      ).run(footprintKeyValue(t, docId, source), profileId);
    } catch (err) {
      throw new Error(
        `Clearing imported ${t.table} rows for document ${docId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }
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
      // #1526: same same-profile invariant for the two newest link columns.
      "skin_lesions",
      "allergies",
    ]) {
      db.prepare(
        `UPDATE ${table} SET encounter_id = NULL
           WHERE profile_id = ? AND encounter_id IS NOT NULL
             AND encounter_id NOT IN (SELECT id FROM encounters WHERE profile_id = ?)`
      ).run(pid, pid);
    }
    // Episode ↔ visit is a link table now (#1198): drop any link row whose encounter no
    // longer lives in that row's profile (a cross-profile link a reassign would strand).
    db.prepare(
      `DELETE FROM episode_encounters
         WHERE profile_id = ?
           AND encounter_id NOT IN (SELECT id FROM encounters WHERE profile_id = ?)`
    ).run(pid, pid);
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
  // Row-ops side-state (#1808): an episode's stopped-med record and a protocol's
  // intervention link must never cross profiles either. NEITHER is caught by an FK — a
  // reassign moves the med with a profile_id UPDATE, and no FK fires on an UPDATE — so
  // without this the SOURCE profile's episode/protocol would be left pointing at a med
  // that now belongs to the DESTINATION profile: a live cross-profile reference nothing
  // refuses. Same re-enforce as the loops above, on BOTH affected profiles: free any link
  // whose med no longer lives in that row's profile (a link whose both ends moved
  // together stays intact). The stop record keeps its `med_name` snapshot, so the episode
  // still says what it stopped; the protocol keeps its own name. A stop record's course
  // belongs to the same med by construction, so it is freed in the same statement.
  for (const pid of [srcProfileId, destProfileId]) {
    db.prepare(
      `UPDATE episode_stopped_meds SET item_id = NULL, course_id = NULL
         WHERE profile_id = ? AND item_id IS NOT NULL
           AND item_id NOT IN (SELECT id FROM intake_items WHERE profile_id = ?)`
    ).run(pid, pid);
    db.prepare(
      `UPDATE protocols SET intake_item_id = NULL
         WHERE profile_id = ? AND intake_item_id IS NOT NULL
           AND intake_item_id NOT IN (
             SELECT id FROM intake_items WHERE profile_id = ?
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
    // Bound from the CLOCK SEAM (sqlNow, #1534) — the same seam `uploaded_at` is
    // written from (lib/medical-pipeline.ts), so the #1022 invariant that a
    // document's completion stamp is never BEHIND its upload stamp holds under the
    // e2e frozen clock too. Mixing the two clocks on one row would break it.
    db.prepare(
      `UPDATE medical_documents
         SET extraction_status = 'done', extraction_completed_at = ?,
             extracted_count = ?, doc_type = ?,
             source = ?, document_date = ?, patient_name = ?, raw_extraction = ?,
             model = ?, import_report = ?, clinical_key = ?, extraction_error = NULL
       WHERE id = ? AND profile_id = ?`
    ).run(
      sqlNow(),
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
      // The CLINICAL identity of this document (#1780): a digest of the source-minted
      // entry ids it just imported. Stamped HERE, at the one 'done' transition every
      // extract/import/reprocess path funnels through, and computed from the SAME
      // PersistInput the ingest probe computes an offered file's key from — so the two
      // sides of the comparison can never be derived differently. NULL for an
      // AI-extracted document (it mints no external_ids) and for a parse too small to
      // have a trustworthy identity, which both mean "not eligible for clinical dedup".
      // Refreshed on every reprocess, so a re-parse that yields different entries
      // updates the identity instead of leaving a stale one behind.
      clinicalKeyForInput(input),
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
       (date, vaccine, dose_label, notes, lot_number, route, site, reaction,
        source, external_id, provider_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
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
        profile_id, loinc, result_status, fasting, specimen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  // Allergies + problem-list conditions. Own tables, same idempotency
  // as the records path: a per-document delete-set clears this document's prior rows
  // (below), then INSERT OR IGNORE dedups within the document via the per-profile
  // unique external_id index (scoped with the document source so two documents each
  // keep their own physical row and a delete never orphans another's).
  // created_at on these three is bound from the CLOCK SEAM (sqlNow, #1534): with no
  // explicit clinical date the stamp IS the record's Timeline day
  // (`substr(created_at, 1, 10)` / dateFromCreatedAt), compared against
  // `today()`-derived bounds.
  const insAllergy = db.prepare(
    `INSERT OR IGNORE INTO allergies
       (substance, substance_code, substance_code_system, reaction, severity,
        status, criticality, verification_status, onset_date, source, document_id,
        external_id, profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insCondition = db.prepare(
    `INSERT OR IGNORE INTO conditions
       (name, code, code_system, status, onset_date, resolved_date,
        source, document_id, external_id, profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
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
        source, document_id, external_id, profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
  // created_at is bound from the CLOCK SEAM (sqlNow, #1534) rather than left to the
  // column's `datetime('now')` default: an intake item's created_at is read as a
  // calendar DAY — `date(created_at)` seeds a medication course's started_on and
  // decides episode membership (getEpisodeMedReconciliation) — against
  // `today()`-derived windows, which SQL's real clock cannot follow across midnight.
  // OBLIGATION (#1505) is BOUND, not literal: an extracted prescription's as-needed
  // sig maps to `may` (the PRN shape the flag collapsed into) and a scheduled one to
  // `must` — the medication default, so an imported prescription arrives with its
  // safety net on rather than silently unmonitored.
  const insMed = db.prepare(
    `INSERT INTO intake_items
       (name, notes, active, condition, obligation, kind,
        prescriber, pharmacy, rx_number,
        document_id, source, provider_id, import_key, profile_id, created_at)
     VALUES (?,?,1,'daily',?,'medication',?,?,?,?,'extracted',?,?,?,?)`
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
      // Administration attributes (#1406) — `?? null` so a PersistInput literal that
      // predates them (the DB-tier fixtures) still writes an honest NULL.
      im.lot_number ?? null,
      im.route ?? null,
      im.site ?? null,
      im.reaction ?? null,
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
      r.loinc ?? null,
      // The result lifecycle + collection attributes the source stated (#1404).
      // Normalized here, at the persist boundary, so a model's freeform status word
      // or an unknown vocabulary value lands as NULL ("unstated") rather than in a
      // column the CHECK would reject.
      normalizeResultStatus(r.result_status),
      parseFasting(r.fasting),
      sanitizeSpecimen(r.specimen)
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
      // Safety attributes (#1405) — `?? null` for the same fixture-compatibility
      // reason as the immunization ones above.
      a.criticality ?? null,
      a.verification_status ?? null,
      a.onset_date,
      docSource,
      docId,
      scopedExternalId(a.external_id),
      profileId,
      sqlNow()
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
      profileId,
      sqlNow()
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
      profileId,
      sqlNow()
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
    // #1526: an allergy documented at a visit the same bundle carries
    // (AllergyIntolerance.encounter) gets the same deterministic tier-1 link, so the
    // attribution arrives with the import instead of waiting for a manual pick.
    linkRowsByExternalId(
      profileId,
      docSource,
      "allergies",
      input.allergies,
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
