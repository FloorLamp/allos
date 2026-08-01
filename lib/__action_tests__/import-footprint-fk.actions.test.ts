// SERVER-ACTION TIER — issue #1808: a document whose extracted medication an illness
// episode later stopped, or a protocol later adopted, must still be deletable,
// reprocessable and reassignable.
//
// Before migration 137 the three ROWS pointing at an extracted med were:
//   medication_courses    ON DELETE CASCADE   fine
//   intake_item_doses     ON DELETE CASCADE   fine
//   episode_stopped_meds  ON DELETE NO ACTION BLOCKS  (item_id, and course_id one
//                                                      CASCADE hop later)
//   protocols             ON DELETE NO ACTION BLOCKS  (intake_item_id)
// so the whole clearImportedDocumentRows transaction rolled back and the document was
// undeletable AND unreprocessable — and reassign, which moves rows by profile_id UPDATE
// (no FK fires on an UPDATE), left the source profile's episode/protocol pointing at the
// DESTINATION profile's med with nothing refusing.
//
// What the fix must produce, asserted here end to end through the real Server Actions:
//   • the delete / reprocess / reassign SUCCEED;
//   • the stop record SURVIVES, keeping its med_name snapshot, with its now-meaningless
//     item_id/course_id degraded to NULL — the episode still says what it stopped;
//   • the episode row itself is untouched;
//   • an UNRELATED stop record (a manual med, another episode) keeps its live link;
//   • the protocol survives with its intervention link nulled.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import {
  deleteMedicalDocument,
  reassignDocument,
} from "@/app/(app)/medical/document-actions";
import type { PersistInput } from "@/lib/import-shape";
import { createLogin, createProfile, actAs, fd } from "./harness";

const DATE = "2020-07-01";

// A one-prescription document: the import projects it into a kind='medication',
// source='extracted' intake_items row — the footprint table this issue is about.
function makeInput(medName: string): PersistInput {
  return {
    records: [
      {
        category: "prescription",
        name: medName,
        canonical: medName,
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take one daily",
        source: "ccda",
        external_id: `med:${medName.toLowerCase()}`,
        loinc: null,
        provider: null,
        courses: null,
      },
    ],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'doc.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

function extractedMedId(profileId: number, docId: number): number {
  const row = db
    .prepare(
      `SELECT id FROM intake_items
        WHERE profile_id = ? AND document_id = ? AND source = 'extracted'`
    )
    .get(profileId, docId) as { id: number } | undefined;
  if (!row) throw new Error("the import produced no extracted medication");
  return row.id;
}

// The open course an episode's end would close. The import may or may not have written
// one; this makes the fixture explicit either way.
function courseFor(itemId: number): number {
  const existing = db
    .prepare(
      `SELECT id FROM medication_courses WHERE item_id = ? ORDER BY id LIMIT 1`
    )
    .get(itemId) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(
    db
      .prepare(
        `INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)`
      )
      .run(itemId, DATE).lastInsertRowid
  );
}

function newEpisode(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(profileId, DATE, DATE).lastInsertRowid
  );
}

function stopRecord(
  profileId: number,
  episodeId: number,
  itemId: number,
  courseId: number,
  medName: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO episode_stopped_meds
           (profile_id, episode_id, item_id, course_id, med_name)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, episodeId, itemId, courseId, medName).lastInsertRowid
  );
}

interface StopRow {
  item_id: number | null;
  course_id: number | null;
  med_name: string;
  episode_id: number;
}

function readStop(id: number): StopRow | undefined {
  return db
    .prepare(
      `SELECT item_id, course_id, med_name, episode_id
         FROM episode_stopped_meds WHERE id = ?`
    )
    .get(id) as StopRow | undefined;
}

function newProtocol(profileId: number, itemId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols (profile_id, name, start_date, intake_item_id)
         VALUES (?, 'Blood pressure trial', ?, ?)`
      )
      .run(profileId, DATE, itemId).lastInsertRowid
  );
}

function protocolItemId(id: number): number | null {
  return (
    db.prepare(`SELECT intake_item_id FROM protocols WHERE id = ?`).get(id) as
      { intake_item_id: number | null } | undefined
  )?.intake_item_id as number | null;
}

// A document with an extracted med that an episode stopped and a protocol adopted, plus
// an unrelated stop record on a MANUAL med that must be left alone.
function seedDocumentWithReferences(medName: string) {
  const admin = createLogin({ role: "admin" });
  const owner = createProfile(`FKOWNER-${medName}`);
  const docId = newDocument(owner.id);
  persistDocumentImport(owner.id, docId, makeInput(medName));
  const itemId = extractedMedId(owner.id, docId);
  const courseId = courseFor(itemId);
  const episodeId = newEpisode(owner.id);
  const stopId = stopRecord(owner.id, episodeId, itemId, courseId, medName);

  // A manual med, its own course, its own stop record on the SAME episode. Nothing about
  // this document should touch it.
  const manualItemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source)
         VALUES (?, 'Manual vitamin D', 'medication', 'manual')`
      )
      .run(owner.id).lastInsertRowid
  );
  const manualStopId = stopRecord(
    owner.id,
    episodeId,
    manualItemId,
    courseFor(manualItemId),
    "Manual vitamin D"
  );

  const protocolId = newProtocol(owner.id, itemId);
  actAs(admin, owner);
  return {
    admin,
    owner,
    docId,
    itemId,
    courseId,
    episodeId,
    stopId,
    manualItemId,
    manualStopId,
    protocolId,
  };
}

describe("deleting a document whose extracted med an episode stopped (#1808)", () => {
  it("succeeds, degrades the stop record to its name, and leaves the episode and unrelated records alone", async () => {
    const s = seedDocumentWithReferences("Lisinopril 10 mg");

    await deleteMedicalDocument(fd({ id: s.docId }));

    // The document and its extracted med are gone.
    expect(
      db.prepare(`SELECT id FROM medical_documents WHERE id = ?`).get(s.docId)
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT id FROM intake_items WHERE id = ?`).get(s.itemId)
    ).toBeUndefined();

    // The stop record SURVIVES: the episode still knows what it stopped, by name, with
    // both now-dangling links honestly nulled (the course went with its med's CASCADE).
    const stop = readStop(s.stopId);
    expect(stop).toBeDefined();
    expect(stop!.item_id).toBeNull();
    expect(stop!.course_id).toBeNull();
    expect(stop!.med_name).toBe("Lisinopril 10 mg");
    expect(stop!.episode_id).toBe(s.episodeId);

    // The episode row itself is untouched.
    expect(
      db
        .prepare(`SELECT id FROM illness_episodes WHERE id = ?`)
        .get(s.episodeId)
    ).toBeDefined();

    // The unrelated stop record keeps its LIVE link — the delete reached only this
    // document's med.
    const manual = readStop(s.manualStopId);
    expect(manual!.item_id).toBe(s.manualItemId);
    expect(manual!.course_id).not.toBeNull();

    // The protocol survives with its intervention link honestly gone.
    expect(protocolItemId(s.protocolId)).toBeNull();
  });

  it("reprocessing the same document also succeeds and preserves the stop record", () => {
    const s = seedDocumentWithReferences("Amoxicillin 500 mg");

    // persistDocumentImport re-runs clearImportedDocumentRows before re-inserting — the
    // reprocess path shares the delete-set, so it tripped the same FK.
    expect(() =>
      persistDocumentImport(
        s.owner.id,
        s.docId,
        makeInput("Amoxicillin 500 mg")
      )
    ).not.toThrow();

    const stop = readStop(s.stopId);
    expect(stop).toBeDefined();
    expect(stop!.med_name).toBe("Amoxicillin 500 mg");
    // The med was re-extracted under a NEW id, so the old link is dead, not silently
    // re-pointed at a row this record never referred to.
    expect(stop!.item_id).toBeNull();
    expect(stop!.course_id).toBeNull();
  });
});

describe("reassigning a document whose extracted med an episode stopped (#1808)", () => {
  it("frees the source profile's stop record and protocol instead of stranding cross-profile links", async () => {
    const s = seedDocumentWithReferences("Metformin 500 mg");
    const dest = createProfile("FKDEST");

    const res = await reassignDocument(
      fd({ id: s.docId, destProfileId: dest.id })
    );
    expect(res.status).toBe("done");

    // The med now belongs to the destination profile…
    const movedTo = db
      .prepare(`SELECT profile_id FROM intake_items WHERE id = ?`)
      .get(s.itemId) as { profile_id: number };
    expect(movedTo.profile_id).toBe(dest.id);

    // …so the SOURCE profile's stop record must no longer point at it. Its narrative
    // survives as the name.
    const stop = readStop(s.stopId);
    expect(stop!.item_id).toBeNull();
    expect(stop!.course_id).toBeNull();
    expect(stop!.med_name).toBe("Metformin 500 mg");

    // Same for the source profile's protocol link.
    expect(protocolItemId(s.protocolId)).toBeNull();

    // The unrelated same-profile record is untouched — both ends still live in the
    // source profile.
    expect(readStop(s.manualStopId)!.item_id).toBe(s.manualItemId);
  });
});
