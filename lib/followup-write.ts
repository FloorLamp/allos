// Auth-BLIND write cores for the finding follow-up chain (issue #700). profileId-
// first, never imports lib/auth — the calling Server Actions
// (app/(app)/imaging/actions.ts, app/(app)/upcoming/actions.ts) own the auth gate.
// Every statement is profile-scoped (WHERE … AND profile_id, and the source/resolving
// study existence is re-checked under profile_id) so a tampered id can't reach or
// resolve another profile's row. All mutations go through writeTx (#468).

import { db, writeTx } from "./db";
import { shiftDateStr } from "./date";
import {
  imagingFollowUpTitle,
  IMAGING_FOLLOWUP_KIND,
} from "./followup-imaging";
import {
  labsFollowUpTitle,
  labBiomarkerName,
  LABS_FOLLOWUP_KIND,
  type LabFollowUpRecord,
} from "./followup-labs";
import { biomarkerFamily } from "./canonical-name";
import { normalizeResolution } from "./followup";
import type { ImagingStudy } from "./types";

// ---- Create: track a follow-up for an imaging study -------------------------

export type TrackFollowUpOutcome =
  | { kind: "created"; carePlanItemId: number }
  | { kind: "exists"; carePlanItemId: number } // an open follow-up already tracks this study
  | { kind: "invalid" }; // no such study for this profile

// Track a follow-up for one imaging study: create a linked, OPEN care_plan_item whose
// planned_date is the study date (or today when the study is undated) + the recommended
// interval, carrying source_kind='imaging' + the source FK + the interval. Idempotent
// per source study while an open one exists (returns "exists"), so a double-click or a
// re-offer can't spawn duplicate follow-ups. `today` seeds the planned_date fallback.
export function trackImagingFollowUpCore(
  profileId: number,
  imagingStudyId: number,
  intervalDays: number,
  today: string
): TrackFollowUpOutcome {
  return writeTx(() => {
    const study = db
      .prepare(
        `SELECT id, modality, body_region, laterality, study_date
           FROM imaging_studies WHERE id = ? AND profile_id = ?`
      )
      .get(imagingStudyId, profileId) as
      | Pick<
          ImagingStudy,
          "id" | "modality" | "body_region" | "laterality" | "study_date"
        >
      | undefined;
    if (!study) return { kind: "invalid" as const };

    // One open follow-up per source study — return the existing one instead of a dup.
    const existing = db
      .prepare(
        `SELECT id FROM care_plan_items
          WHERE profile_id = ? AND source_kind = ?
            AND source_imaging_study_id = ? AND resolution IS NULL`
      )
      .get(profileId, IMAGING_FOLLOWUP_KIND, imagingStudyId) as
      { id: number } | undefined;
    if (existing)
      return { kind: "exists" as const, carePlanItemId: existing.id };

    const interval =
      Number.isFinite(intervalDays) && intervalDays > 0
        ? Math.floor(intervalDays)
        : 0;
    const base = study.study_date ?? today;
    const plannedDate = interval > 0 ? shiftDateStr(base, interval) : base;
    // studyDisplayLabel needs contrast; the title helper only reads modality/region,
    // so a partial study row is enough here.
    const title = imagingFollowUpTitle({
      ...(study as ImagingStudy),
      contrast: false,
    });

    const info = db
      .prepare(
        `INSERT INTO care_plan_items
           (description, category, planned_date, status, source, source_kind,
            source_imaging_study_id, recommended_interval_days, profile_id)
         VALUES (?, 'follow-up', ?, NULL, NULL, ?, ?, ?, ?)`
      )
      .run(
        title,
        plannedDate,
        IMAGING_FOLLOWUP_KIND,
        imagingStudyId,
        interval > 0 ? interval : null,
        profileId
      );
    return {
      kind: "created" as const,
      carePlanItemId: Number(info.lastInsertRowid),
    };
  });
}

// ---- Resolve: close a follow-up against a later record ----------------------

export type ResolveFollowUpOutcome =
  | { kind: "resolved" }
  | { kind: "invalid-resolution" } // not one of resolved/stable/changed
  | { kind: "not-found" }; // no such open linked follow-up (or resolving study) for this profile

// Where a resolution's "resolved by" link is stored + validated, per domain adapter
// kind. Both the table and the column are HARDCODED constants (never user input), so
// interpolating them into the SQL below is injection-safe — the same finite-preimage
// realization the biomarker family SQL uses. A follow-up's source_kind picks the pair;
// an unknown kind is refused (treated as not-found) so a resolve can never write a
// resolving link into the wrong column.
const RESOLVE_TARGET_BY_KIND: Record<
  string,
  { table: string; resolvedCol: string }
> = {
  [IMAGING_FOLLOWUP_KIND]: {
    table: "imaging_studies",
    resolvedCol: "resolved_by_imaging_study_id",
  },
  [LABS_FOLLOWUP_KIND]: {
    table: "medical_records",
    resolvedCol: "resolved_by_medical_record_id",
  },
};

// Record a resolution (resolved/stable/changed) against a follow-up, confirm-first
// (#560): marks the care_plan_item completed, stores the outcome, and links the
// resolving record. Domain-agnostic — it dispatches on the follow-up's source_kind
// (imaging → imaging_studies, labs → medical_records) so ONE core (and ONE Server
// Action) serves every adapter. Profile-scoped on BOTH the follow-up and the resolving
// record, so neither can point cross-profile. `resolvingRecordId` may be null (record
// the outcome without pinning a specific record), but when given it must belong to the
// profile — otherwise the whole resolve is refused (never silently drop the link).
export function resolveFollowUpCore(
  profileId: number,
  carePlanItemId: number,
  resolution: string,
  resolvingRecordId: number | null
): ResolveFollowUpOutcome {
  const outcome = normalizeResolution(resolution);
  if (!outcome) return { kind: "invalid-resolution" };
  return writeTx(() => {
    const followUp = db
      .prepare(
        `SELECT id, source_kind FROM care_plan_items
          WHERE id = ? AND profile_id = ?
            AND source_kind IS NOT NULL AND resolution IS NULL`
      )
      .get(carePlanItemId, profileId) as
      { id: number; source_kind: string } | undefined;
    if (!followUp) return { kind: "not-found" as const };

    const target = RESOLVE_TARGET_BY_KIND[followUp.source_kind];
    if (!target) return { kind: "not-found" as const };

    if (resolvingRecordId != null) {
      const rec = db
        .prepare(
          `SELECT id FROM ${target.table} WHERE id = ? AND profile_id = ?`
        )
        .get(resolvingRecordId, profileId) as { id: number } | undefined;
      if (!rec) return { kind: "not-found" as const };
    }

    db.prepare(
      `UPDATE care_plan_items
          SET resolution = ?, ${target.resolvedCol} = ?,
              resolved_at = datetime('now'), status = 'completed'
        WHERE id = ? AND profile_id = ?`
    ).run(outcome, resolvingRecordId, carePlanItemId, profileId);
    return { kind: "resolved" as const };
  });
}

// ---- Create: track a follow-up for a flagged lab reading (#700 labs) ---------

// Track a follow-up for one flagged biomarker reading: create a linked, OPEN
// care_plan_item whose planned_date is the reading date + the recommended interval,
// carrying source_kind='labs' + the source medical_records FK + the interval, so a
// flagged result ("A1c 8.2%") becomes a legible, resolvable "Recheck A1c" follow-up.
// Idempotent per #482 biomarker FAMILY while an open one exists (returns "exists"),
// so tracking from an A1c reading and then from an eAG reading of the same family
// can't spawn two follow-ups. `today` seeds the planned_date fallback (unused in
// practice — a reading always has a date).
export function trackLabFollowUpCore(
  profileId: number,
  medicalRecordId: number,
  intervalDays: number,
  today: string
): TrackFollowUpOutcome {
  return writeTx(() => {
    const record = db
      .prepare(
        `SELECT id, date, canonical_name, name, value, unit, value_num, flag
           FROM medical_records WHERE id = ? AND profile_id = ?`
      )
      .get(medicalRecordId, profileId) as LabFollowUpRecord | undefined;
    if (!record) return { kind: "invalid" as const };

    // One open follow-up per source biomarker FAMILY (#482), not per exact reading:
    // load the profile's open labs follow-ups + their source readings and match on
    // family in JS (few follow-ups), so a re-offer or a sibling-analyte reading
    // returns the existing follow-up instead of a duplicate.
    const targetFamily = biomarkerFamily(
      labBiomarkerName(record)
    ).toLowerCase();
    const openFollowUps = db
      .prepare(
        `SELECT cp.id AS cpId,
                COALESCE(NULLIF(TRIM(mr.canonical_name), ''), mr.name) AS sourceName
           FROM care_plan_items cp
           JOIN medical_records mr
             ON mr.id = cp.source_medical_record_id AND mr.profile_id = cp.profile_id
          WHERE cp.profile_id = ? AND cp.source_kind = ?
            AND cp.source_medical_record_id IS NOT NULL AND cp.resolution IS NULL`
      )
      .all(profileId, LABS_FOLLOWUP_KIND) as {
      cpId: number;
      sourceName: string;
    }[];
    const existing = openFollowUps.find(
      (r) => biomarkerFamily(r.sourceName).toLowerCase() === targetFamily
    );
    if (existing)
      return { kind: "exists" as const, carePlanItemId: existing.cpId };

    const interval =
      Number.isFinite(intervalDays) && intervalDays > 0
        ? Math.floor(intervalDays)
        : 0;
    const base = record.date ?? today;
    const plannedDate = interval > 0 ? shiftDateStr(base, interval) : base;
    const title = labsFollowUpTitle(record);

    const info = db
      .prepare(
        `INSERT INTO care_plan_items
           (description, category, planned_date, status, source, source_kind,
            source_medical_record_id, recommended_interval_days, profile_id)
         VALUES (?, 'follow-up', ?, NULL, NULL, ?, ?, ?, ?)`
      )
      .run(
        title,
        plannedDate,
        LABS_FOLLOWUP_KIND,
        medicalRecordId,
        interval > 0 ? interval : null,
        profileId
      );
    return {
      kind: "created" as const,
      carePlanItemId: Number(info.lastInsertRowid),
    };
  });
}

// NULL the follow-up chain links that point at a medical_records reading about to be
// deleted (#199-#203), the labs mirror of unlinkFollowUpsForImagingStudy. A follow-up
// whose SOURCE reading is deleted degrades to a generic care-plan item (source_kind +
// source FK cleared), and a resolution recorded against a now-deleted later reading
// keeps its outcome text but drops the dead link. Called BEFORE the medical_records
// DELETE so the REFERENCES FKs don't trip. Profile-scoped.
export function unlinkFollowUpsForMedicalRecord(
  profileId: number,
  recordId: number
): void {
  db.prepare(
    `UPDATE care_plan_items
        SET source_kind = NULL, source_medical_record_id = NULL
      WHERE profile_id = ? AND source_medical_record_id = ?`
  ).run(profileId, recordId);
  db.prepare(
    `UPDATE care_plan_items
        SET resolved_by_medical_record_id = NULL
      WHERE profile_id = ? AND resolved_by_medical_record_id = ?`
  ).run(profileId, recordId);
}

// ---- Row-ops: unlink follow-ups when a source study is deleted --------------

// NULL the follow-up chain links that point at an imaging study about to be deleted
// (#199-#203). A follow-up whose SOURCE study is deleted degrades to a generic
// care-plan item (source_kind + source FK cleared — it keeps the planned care, loses
// the finding linkage), and a resolution recorded against a now-deleted later study
// keeps its outcome text but drops the dead link. Called BEFORE the imaging_studies
// DELETE so the REFERENCES FKs don't trip. Profile-scoped.
export function unlinkFollowUpsForImagingStudy(
  profileId: number,
  studyId: number
): void {
  db.prepare(
    `UPDATE care_plan_items
        SET source_kind = NULL, source_imaging_study_id = NULL
      WHERE profile_id = ? AND source_imaging_study_id = ?`
  ).run(profileId, studyId);
  db.prepare(
    `UPDATE care_plan_items
        SET resolved_by_imaging_study_id = NULL
      WHERE profile_id = ? AND resolved_by_imaging_study_id = ?`
  ).run(profileId, studyId);
}
