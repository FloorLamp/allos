// DB INTEGRATION TIER (not the pure suite). Exercises the medication-course import
// path: persistDocumentImport turning a prescription record's DERIVED courses into
// medication_courses rows, keeping intake_items.active in sync with the course
// state, falling back to the Phase-1 single open course when the source carried no
// period, and staying idempotent across a reprocess. Also pins what the projected
// med's DOSE ROW holds for a real Epic sig / product string (#2939) — the parse is
// unit-tested in lib/__tests__/prescription-parse.test.ts, but only the persist path
// shows which column each half lands in. Runs via `npm run test:db`.

import { describe, it, expect, beforeAll } from "vitest";
import { persistDocumentImport } from "@/lib/import-persist";
import type {
  PersistInput,
  PersistClinicalObservation,
} from "@/lib/import-shape";
import type { ImportedMedicationCourse } from "@/lib/health-import";
import { db } from "@/lib/db";

const DATE = "2024-01-01";

function rx(
  name: string,
  courses: ImportedMedicationCourse[] | null,
  value: string | null = null
): PersistClinicalObservation {
  return {
    category: "prescription",
    name,
    canonical: name,
    value,
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

function inputWith(observations: PersistClinicalObservation[]): PersistInput {
  return {
    observations,
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

  // #2939 — the strings a live import actually carried. The dose row's `amount` is
  // what the Today panel renders and what every strength reader parses, so the split
  // between "the dose" and "everything else the source said" is asserted per column.
  it("stores the DOSE in the dose row and the SIG in the item's notes", () => {
    const p = newProfile("MED-SIG-SPLIT");
    const d = newDocument(p);
    persistDocumentImport(
      p,
      d,
      inputWith([
        rx(
          "albuterol",
          null,
          "Take 1.5 mL (1.25 mg) by nebulization every 6 (six) hours if needed for wheezing."
        ),
        rx(
          "amoxicillin",
          null,
          "Amoxicillin 400 MG/5ML Suspension Reconstituted"
        ),
      ])
    );

    const doseOf = (name: string) =>
      db
        .prepare(
          "SELECT amount FROM intake_item_doses WHERE item_id = ? ORDER BY id"
        )
        .all(medId(p, name)) as { amount: string | null }[];
    const notesOf = (name: string) =>
      (
        db
          .prepare("SELECT notes FROM intake_items WHERE id = ?")
          .get(medId(p, name)) as { notes: string | null }
      ).notes;

    // The sig is directions, not a strength: the dose row holds the dose it states,
    // the sentence rides along in the item's notes.
    expect(doseOf("albuterol")).toEqual([{ amount: "1.5 mL (1.25 mg)" }]);
    expect(notesOf("albuterol")).toContain("if needed for wheezing");

    // A product string is neither: its concentration is the strength, and the row
    // never stores the product name as an amount.
    expect(doseOf("amoxicillin")).toEqual([{ amount: "400 MG/5ML" }]);
  });

  // The UPGRADED-INSTALL case. A med tracked by an older build stored its strength
  // numerator-only ("2.5 mg"), because the parser of the day stopped at the numerator.
  // getMedMatchStates re-derives existing strengths from those STORED dose amounts
  // while the incoming prescription is parsed with the current grammar
  // ("2.5 mg/3 mL"), so the two could never intersect and every concentration-dosed
  // med forked a duplicate item at its next refill. A fresh fixture cannot show this —
  // it needs a row written the old way, which this sets up by hand.
  it("renews against a strength stored numerator-only by an older build", () => {
    const p = newProfile("MED-UPGRADED-INSTALL");
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind)
           VALUES (?, 'albuterol', 1, 'medication')`
        )
        .run(p).lastInsertRowid
    );
    // Written by the previous build: the denominator is simply not on disk.
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, sort)
       VALUES (?, '2.5 mg', NULL, 0)`
    ).run(item);
    // Open course, started before this document's date so the renewal attaches as a
    // SECOND course rather than deduping onto the same (item_id, started_on).
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2023-06-01')`
    ).run(item);

    persistDocumentImport(
      p,
      newDocument(p),
      inputWith([rx("albuterol (2.5 mg/3 mL) nebulizer solution", null)])
    );

    // ONE albuterol, carrying a second course — not a forked duplicate item.
    const items = db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'"
      )
      .all(p) as { id: number }[];
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(item);
    expect(coursesOf(item).length).toBeGreaterThan(1);
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
