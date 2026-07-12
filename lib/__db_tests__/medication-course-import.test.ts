// DB INTEGRATION TIER (not the pure suite). Exercises the medication-course import
// path: persistDocumentImport turning a prescription record's DERIVED courses into
// medication_courses rows, keeping intake_items.active in sync with the course
// state, falling back to the Phase-1 single open course when the source carried no
// period, and staying idempotent across a reprocess. Runs via `npm run test:db`.

import { describe, it, expect, beforeAll } from "vitest";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput, PersistRecord } from "@/lib/import-shape";
import type { ImportedMedicationCourse } from "@/lib/health-import";
import { db } from "@/lib/db";

const DATE = "2024-01-01";

function rx(
  name: string,
  courses: ImportedMedicationCourse[] | null
): PersistRecord {
  return {
    category: "prescription",
    name,
    canonical: name,
    value: null,
    value_num: null,
    unit: null,
    date: DATE,
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source: null,
    external_id: `med:${name}`,
    loinc: null,
    provider: null,
    courses,
  };
}

function inputWith(records: PersistRecord[]): PersistInput {
  return {
    records,
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
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'meds.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

function medId(profileId: number, name: string): number {
  return (
    db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND name = ? AND kind = 'medication'"
      )
      .get(profileId, name) as { id: number }
  ).id;
}

function coursesOf(itemId: number): {
  started_on: string | null;
  stopped_on: string | null;
  stop_reason: string | null;
}[] {
  return db
    .prepare(
      "SELECT started_on, stopped_on, stop_reason FROM medication_courses WHERE item_id = ? ORDER BY started_on, id"
    )
    .all(itemId) as any;
}

function activeOf(itemId: number): number {
  return (
    db.prepare("SELECT active FROM intake_items WHERE id = ?").get(itemId) as {
      active: number;
    }
  ).active;
}

let profile: number;
let doc: number;

// One MedicationStatement-style med with TWO episodes (an old completed course +
// a current open course), a fully-stopped med, and a med with NO derived courses.
const TWO_PERIOD: ImportedMedicationCourse[] = [
  {
    started_on: "2020-01-01",
    stopped_on: "2020-06-01",
    stop_reason: "completed_course",
    notes: null,
  },
  {
    started_on: "2023-01-01",
    stopped_on: null,
    stop_reason: null,
    notes: null,
  },
];
const STOPPED: ImportedMedicationCourse[] = [
  {
    started_on: "2024-02-01",
    stopped_on: "2024-02-11",
    stop_reason: "provider_discontinued",
    notes: "Muscle pain",
  },
];

beforeAll(() => {
  profile = newProfile("MED-COURSE");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    inputWith([
      rx("Warfarin", TWO_PERIOD),
      rx("Atorvastatin", STOPPED),
      rx("Lisinopril", null), // no period → Phase-1 single open course fallback
    ])
  );
});

describe("persist derived medication courses", () => {
  it("a two-period med yields two courses (open + closed) with active=1 (latest open)", () => {
    const id = medId(profile, "Warfarin");
    expect(coursesOf(id)).toEqual([
      {
        started_on: "2020-01-01",
        stopped_on: "2020-06-01",
        stop_reason: "completed_course",
      },
      { started_on: "2023-01-01", stopped_on: null, stop_reason: null },
    ]);
    // latest course open → active synced to 1
    expect(activeOf(id)).toBe(1);
  });

  it("a fully-stopped med → one closed course, active synced to 0", () => {
    const id = medId(profile, "Atorvastatin");
    const courses = coursesOf(id);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      started_on: "2024-02-01",
      stopped_on: "2024-02-11",
      stop_reason: "provider_discontinued",
    });
    expect(activeOf(id)).toBe(0);
  });

  it("a med with no derived period falls back to a single open course", () => {
    const id = medId(profile, "Lisinopril");
    const courses = coursesOf(id);
    expect(courses).toHaveLength(1);
    expect(courses[0].stopped_on).toBeNull(); // open
    expect(activeOf(id)).toBe(1);
  });

  it("reprocess is idempotent: courses are re-created, never duplicated", () => {
    persistDocumentImport(
      profile,
      doc,
      inputWith([
        rx("Warfarin", TWO_PERIOD),
        rx("Atorvastatin", STOPPED),
        rx("Lisinopril", null),
      ])
    );
    // Same course counts + active after reprocess (the med row + its courses are
    // deleted by document_id and re-created from the import).
    const w = medId(profile, "Warfarin");
    expect(coursesOf(w)).toHaveLength(2);
    expect(activeOf(w)).toBe(1);
    expect(coursesOf(medId(profile, "Atorvastatin"))).toHaveLength(1);
    expect(activeOf(medId(profile, "Atorvastatin"))).toBe(0);
    expect(coursesOf(medId(profile, "Lisinopril"))).toHaveLength(1);
    // No orphaned courses across the whole profile's meds: exactly 2 + 1 + 1.
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM medication_courses mc
             JOIN intake_items ii ON ii.id = mc.item_id
            WHERE ii.profile_id = ?`
        )
        .get(profile) as { c: number }
    ).c;
    expect(total).toBe(4);
  });

  it("a [closed, open] union at the SAME start persists only the closed course and active=0", () => {
    // The F1 regression: dedup by (item_id, started_on) keeps the FIRST-inserted
    // course at a shared start, so a completed record ordered before an active one
    // (same start) drops the open course. `active` must follow what PERSISTED — a
    // lone closed course → active=0 — never the input array (which had an "open").
    const p3 = newProfile("MED-INVARIANT");
    const d3 = newDocument(p3);
    persistDocumentImport(
      p3,
      d3,
      inputWith([
        // same drug name → grouped + unioned in record order: [closed, open]
        rx("Prednisone", [
          {
            started_on: "2024-01-01",
            stopped_on: "2024-03-01",
            stop_reason: "completed_course",
            notes: null,
          },
        ]),
        rx("Prednisone", [
          {
            started_on: "2024-01-01",
            stopped_on: null,
            stop_reason: null,
            notes: null,
          },
        ]),
      ])
    );
    const id = medId(p3, "Prednisone");
    const courses = coursesOf(id);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      started_on: "2024-01-01",
      stopped_on: "2024-03-01", // closed course survived; the open one was dropped
    });
    expect(activeOf(id)).toBe(0); // active derived from persisted rows, not input
  });

  it("dedups courses sharing a start (item_id, started_on)", () => {
    const p2 = newProfile("MED-DEDUP");
    const d2 = newDocument(p2);
    persistDocumentImport(
      p2,
      d2,
      inputWith([
        rx("Metformin", [
          {
            started_on: "2024-01-01",
            stopped_on: null,
            stop_reason: null,
            notes: null,
          },
          // duplicate start — must collapse to the first-inserted row
          {
            started_on: "2024-01-01",
            stopped_on: "2024-05-01",
            stop_reason: "completed_course",
            notes: null,
          },
        ]),
      ])
    );
    expect(coursesOf(medId(p2, "Metformin"))).toHaveLength(1);
  });
});
