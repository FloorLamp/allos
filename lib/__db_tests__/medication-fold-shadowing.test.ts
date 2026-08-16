// DB INTEGRATION TIER — the extracted-medication fold escape from the #2919 audit.
//
// Three overlapping portal exports re-listed ~24 meds; all but one folded as renewal
// courses. The escapes traced to ONE defect with two legs: the import matched the
// FIRST existing med sharing the drug's name key and classified only against THAT
// one. When that first candidate had an open course plus mismatching strength
// evidence, the #1027 concurrent carve-out returned "separate" — by the book — and
// permanently shadowed the identical twin further down the id order that would have
// renewed. First-match was correct while at most one item per key could exist; this
// bug is how a second one arises, after which first-match perpetuates it.
//
// Leg 1 here: a legitimate MANUAL "Acetaminophen 500 mg" with an open course, sitting
// at a lower id than every extracted 325 MG twin, spawned a fresh item on every
// import (the observed items 243/247/248, one per document).
//
// Deterministic: :memory: DB via setup.ts; fixed dates; low-entropy values.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import type {
  PersistInput,
  PersistClinicalObservation,
} from "@/lib/import-shape";

const DATE = "2019-04-02";

function emptyInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    observations: [],
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
    canonicalNamesToRegister: [],
    providers: [],
    meta: {
      docType: "ccd",
      source: "Test Clinic",
      documentDate: DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    ...over,
  };
}

function prescription(
  over: Partial<PersistClinicalObservation> = {}
): PersistClinicalObservation {
  return {
    category: "prescription",
    name: "Acetaminophen 325 MG",
    canonical: "Acetaminophen 325 MG",
    value: null,
    value_num: null,
    unit: null,
    date: DATE,
    reference_range: null,
    flag: null,
    panel: null,
    notes: "Take 1 tablet by mouth every 6 hours as needed",
    source: null,
    external_id: "med:acetaminophen",
    loinc: null,
    provider: null,
    ...over,
  } as PersistClinicalObservation;
}

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
           (profile_id, filename, stored_path, extraction_status)
         VALUES (?, ?, '', 'pending')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

function medRows(profileId: number) {
  return db
    .prepare(
      `SELECT id, name, source FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' ORDER BY id`
    )
    .all(profileId) as { id: number; name: string; source: string | null }[];
}

function courseCount(itemId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?")
      .get(itemId) as { n: number }
  ).n;
}

// A hand-entered medication the person actually takes, with an OPEN course.
function manualMed(profileId: number, name: string, startedOn: string): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, kind, name, source)
         VALUES (?, 'medication', ?, 'manual')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on)
     VALUES (?, ?, NULL)`
  ).run(id, startedOn);
  return id;
}

describe("re-importing one prescription folds as a renewal (#2919)", () => {
  it("keeps ONE item and adds a course on the second document", () => {
    const profile = newProfile("Two Exports");
    persistDocumentImport(
      profile,
      newDocument(profile, "export-1.xml"),
      emptyInput({ observations: [prescription()] })
    );
    const afterFirst = medRows(profile);
    expect(afterFirst).toHaveLength(1);

    persistDocumentImport(
      profile,
      newDocument(profile, "export-2.xml"),
      emptyInput({ observations: [prescription()] })
    );

    const afterSecond = medRows(profile);
    expect(afterSecond.map((m) => m.id)).toEqual([afterFirst[0].id]);
    expect(courseCount(afterFirst[0].id)).toBeGreaterThan(1);
  });
});

describe("a manual different-strength med must not shadow its twin (#2919)", () => {
  it("renews onto the extracted twin instead of spawning a third item", () => {
    const profile = newProfile("Shadowed Twin");
    // Lower id than every extracted row, open course, genuinely different strength —
    // so this candidate correctly classifies as "separate" every single time.
    const manual = manualMed(profile, "Acetaminophen 500 mg", "2019-01-01");

    persistDocumentImport(
      profile,
      newDocument(profile, "export-1.xml"),
      emptyInput({ observations: [prescription()] })
    );
    const afterFirst = medRows(profile);
    // The manual med stays its own item — #1027's concurrent carve-out is intact.
    expect(afterFirst.map((m) => m.id)).toContain(manual);
    expect(afterFirst).toHaveLength(2);
    const twin = afterFirst.find((m) => m.id !== manual)!;

    // Two more exports carrying the identical prescription.
    for (const name of ["export-2.xml", "export-3.xml"]) {
      persistDocumentImport(
        profile,
        newDocument(profile, name),
        emptyInput({ observations: [prescription()] })
      );
    }

    // Before the fix this was four items — one per document past the first.
    expect(medRows(profile).map((m) => m.id)).toEqual([manual, twin.id]);
    expect(courseCount(twin.id)).toBeGreaterThan(1);
    // The person's own row is untouched.
    expect(courseCount(manual)).toBe(1);
  });

  it("still keeps a genuinely concurrent second product separate", () => {
    // The #1027 case the carve-out exists for: an open course at one strength and an
    // incoming order at another, with NO identical twin to renew onto.
    const profile = newProfile("Concurrent Strengths");
    const manual = manualMed(profile, "Ibuprofen 200 mg", "2019-01-01");
    persistDocumentImport(
      profile,
      newDocument(profile, "export-1.xml"),
      emptyInput({
        observations: [
          prescription({
            name: "Ibuprofen 800 MG",
            canonical: "Ibuprofen 800 MG",
            external_id: "med:ibuprofen",
          }),
        ],
      })
    );
    const rows = medRows(profile);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(manual);
  });
});
