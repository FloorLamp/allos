// DB INTEGRATION TIER — imaging_studies and care_plan_items collapse cross-document
// duplicates like every other import domain (issue #2919).
//
// Three overlapping MyChart exports for one profile: the registry-collapsed domains
// absorbed the overlap exactly as designed, but these two never joined the registry —
// imaging_studies (#702) and care_plan_items post-date #134's sweep, which is why
// #2035's consolidation of "the seven sites" did not include them. Six distinct
// studies appeared eighteen times; five plan items appeared fifteen.
//
// The acceptance shape is #134's: the same entry imported from two overlapping
// documents renders ONCE on every read surface, and deleting one document leaves the
// survivor visible.
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getCarePlanItems,
  getImagingStudies,
  getImagingStudiesForProfiles,
} from "@/lib/queries";
import { searchAll } from "@/lib/queries/search";
import { getTimelineEvents } from "@/lib/timeline";
import { carePlanItems } from "@/lib/queries/upcoming/plans";
import { testAuthorizedIds as authorized } from "../__tests__/authorized-ids";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'done', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// The source system's own study id, stored DOCUMENT-SCOPED exactly as the import
// writes it (`document:<id>|ccda:imaging:<sourceId>`), so each export keeps its own
// physical row — storage left verbatim, per #2589's costing ruling.
function newStudy(
  profileId: number,
  documentId: number,
  sourceId: string,
  bodyRegion: string,
  studyDate: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO imaging_studies
           (profile_id, document_id, external_id, modality, body_region,
            study_date, source)
         VALUES (?, ?, ?, 'ultrasound', ?, ?, 'document:import')`
      )
      .run(
        profileId,
        documentId,
        `document:${documentId}|ccda:imaging:${sourceId}`,
        bodyRegion,
        studyDate
      ).lastInsertRowid
  );
}

function newPlanItem(
  profileId: number,
  documentId: number,
  sourceId: string,
  description: string,
  plannedDate: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO care_plan_items
           (profile_id, document_id, external_id, description, planned_date,
            status, source)
         VALUES (?, ?, ?, ?, ?, 'active', 'document:import')`
      )
      .run(
        profileId,
        documentId,
        `document:${documentId}|ccda:careplan:${sourceId}`,
        description,
        plannedDate
      ).lastInsertRowid
  );
}

// Two overlapping exports, each carrying the same study and the same plan item.
function seedOverlappingExports(name: string) {
  const profile = newProfile(name);
  const first = newDocument(profile, "export-1.xml");
  const second = newDocument(profile, "export-2.xml");
  const studyA = newStudy(profile, first, "27044", "breast", "2019-04-02");
  const studyB = newStudy(profile, second, "27044", "breast", "2019-04-02");
  newPlanItem(profile, first, "171149006", "Flu vaccine plan", "2019-10-01");
  const planB = newPlanItem(
    profile,
    second,
    "171149006",
    "Flu vaccine plan",
    "2019-10-01"
  );
  return { profile, first, second, studyA, studyB, planB };
}

describe("imaging studies collapse across overlapping exports (#2919)", () => {
  it("renders once on the imaging list, Timeline and Search", () => {
    const { profile } = seedOverlappingExports("Imaging Overlap");

    expect(getImagingStudies(profile)).toHaveLength(1);
    expect(getImagingStudiesForProfiles(authorized([profile]))).toHaveLength(1);
    expect(
      getTimelineEvents(profile, { limit: 200 }).filter(
        (e) => e.category === "imaging"
      )
    ).toHaveLength(1);
    expect(
      searchAll(profile, "breast", null).filter((h) => h.domain === "imaging")
    ).toHaveLength(1);
  });

  it("leaves the survivor visible when one document is deleted", () => {
    const { profile, studyB } = seedOverlappingExports("Imaging Delete");
    // The representative is the newest physical row; delete THAT one.
    expect(getImagingStudies(profile)[0].id).toBe(studyB);
    db.prepare("DELETE FROM imaging_studies WHERE id = ?").run(studyB);

    const remaining = getImagingStudies(profile);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).not.toBe(studyB);
  });

  it("keeps genuinely different studies apart", () => {
    const profile = newProfile("Two Studies");
    const docId = newDocument(profile, "export-1.xml");
    newStudy(profile, docId, "27044", "breast", "2019-04-02");
    newStudy(profile, docId, "27045", "abdomen", "2019-04-02");
    expect(getImagingStudies(profile)).toHaveLength(2);
  });
});

describe("care-plan items collapse across overlapping exports (#2919)", () => {
  it("renders once on the care-plan list, Upcoming and Search", () => {
    const { profile } = seedOverlappingExports("Care Plan Overlap");

    expect(getCarePlanItems(profile)).toHaveLength(1);
    expect(
      searchAll(profile, "flu vaccine", null).filter(
        (h) => h.domain === "care-plan"
      )
    ).toHaveLength(1);
    expect(carePlanItems(profile)).toHaveLength(1);
  });

  it("leaves the survivor visible when one document is deleted", () => {
    const { profile, planB } = seedOverlappingExports("Care Plan Delete");
    expect(getCarePlanItems(profile)[0].id).toBe(planB);
    db.prepare("DELETE FROM care_plan_items WHERE id = ?").run(planB);

    const remaining = getCarePlanItems(profile);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).not.toBe(planB);
  });

  it("never collapses two follow-up chain nodes that share a title and date", () => {
    // Follow-ups are minted one per SOURCE RECORD and their titles are not unique —
    // the imaging title helper reads only modality + region, so two same-day knee
    // x-rays produce two identical-looking rows. Collapsing them would drop a due
    // recheck, so a chain node is always its own identity.
    const profile = newProfile("Two Follow-ups");
    const docId = newDocument(profile, "export-1.xml");
    const left = newStudy(profile, docId, "27100", "knee", "2019-04-02");
    const right = newStudy(profile, docId, "27101", "knee", "2019-04-02");
    for (const studyId of [left, right]) {
      db.prepare(
        `INSERT INTO care_plan_items
           (profile_id, description, category, planned_date, source_kind,
            source_imaging_study_id)
         VALUES (?, 'Repeat knee x-ray', 'follow-up', '2019-10-01', 'imaging', ?)`
      ).run(profile, studyId);
    }
    expect(getCarePlanItems(profile)).toHaveLength(2);
  });
});
