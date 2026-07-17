// Auth-BLIND write cores for the finding follow-up chain (issue #700). profileId-
// first, never imports lib/auth — the calling Server Actions
// (app/(app)/imaging/actions.ts, app/(app)/upcoming/actions.ts) own the auth gate.
// Every statement is profile-scoped (WHERE … AND profile_id, and the source/resolving
// study existence is re-checked under profile_id) so a tampered id can't reach or
// resolve another profile's row. All mutations go through writeTx (#468).

import { db, writeTx } from "./db";
import { shiftDateStr } from "./date";
import { imagingFollowUpTitle, IMAGING_FOLLOWUP_KIND } from "./followup-imaging";
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
      | { id: number }
      | undefined;
    if (existing) return { kind: "exists" as const, carePlanItemId: existing.id };

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

// Record a resolution (resolved/stable/changed) against a follow-up, confirm-first
// (#560): marks the care_plan_item completed, stores the outcome, and links the
// resolving imaging study. Profile-scoped on BOTH the follow-up and the resolving
// study, so neither can point cross-profile. `resolvingStudyId` may be null (record
// the outcome without pinning a specific study), but when given it must belong to the
// profile — otherwise the whole resolve is refused (never silently drop the link).
export function resolveFollowUpCore(
  profileId: number,
  carePlanItemId: number,
  resolution: string,
  resolvingStudyId: number | null
): ResolveFollowUpOutcome {
  const outcome = normalizeResolution(resolution);
  if (!outcome) return { kind: "invalid-resolution" };
  return writeTx(() => {
    const followUp = db
      .prepare(
        `SELECT id FROM care_plan_items
          WHERE id = ? AND profile_id = ?
            AND source_kind IS NOT NULL AND resolution IS NULL`
      )
      .get(carePlanItemId, profileId) as { id: number } | undefined;
    if (!followUp) return { kind: "not-found" as const };

    if (resolvingStudyId != null) {
      const study = db
        .prepare(
          "SELECT id FROM imaging_studies WHERE id = ? AND profile_id = ?"
        )
        .get(resolvingStudyId, profileId) as { id: number } | undefined;
      if (!study) return { kind: "not-found" as const };
    }

    db.prepare(
      `UPDATE care_plan_items
          SET resolution = ?, resolved_by_imaging_study_id = ?,
              resolved_at = datetime('now'), status = 'completed'
        WHERE id = ? AND profile_id = ?`
    ).run(outcome, resolvingStudyId, carePlanItemId, profileId);
    return { kind: "resolved" as const };
  });
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
