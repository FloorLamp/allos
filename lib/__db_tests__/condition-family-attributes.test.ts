// DB INTEGRATION TIER — condition laterality/severity/stage (#1403) and the family
// history death facts + genetic discriminator (#1407).
//
// Covers what only a real database can prove:
//   1. Migrations 144/145 actually shipped the columns, with their CHECK sets live.
//   2. The IMPORT path round-trips them — a CCD/FHIR projection that states a side
//      and a grade lands them on the row instead of dropping them (the whole point
//      of #1403), and a family projection lands the death facts and the axis.
//   3. Laterality is IDENTITY in the read path: a left-knee and a right-knee row
//      that share a name AND a code both survive the representative dedupe.
//   4. The risk gather over real rows excludes a non-genetic relative and lifts a
//      genetic relative's cause of death into the cadence engine.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getConditions, getFamilyHistory } from "@/lib/queries";
import { getRiskFactors } from "@/lib/queries/upcoming/risk";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";

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
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

function emptyInput(): PersistInput {
  return {
    records: [],
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
      source: "MyChart",
      documentDate: "2024-05-12",
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

let pImport: number;
let pRisk: number;

beforeAll(() => {
  pImport = newProfile("ATTR-IMPORT");
  pRisk = newProfile("ATTR-RISK");

  // An imported document that STATES a side, a grade and a stage on one condition
  // and leaves them unstated on another, plus a family row with the death facts.
  const doc = newDocument(pImport, "attrs.ccd");
  persistDocumentImport(pImport, doc, {
    ...emptyInput(),
    conditions: [
      {
        name: "Osteoarthritis of knee",
        code: "M17.9",
        code_system: "ICD-10-CM",
        status: "active",
        laterality: "left",
        severity: "moderate",
        stage: null,
        onset_date: "2021-06-04",
        resolved_date: null,
        external_id: "ccda:condition:M17.9:left",
      },
      {
        name: "Osteoarthritis of knee",
        code: "M17.9",
        code_system: "ICD-10-CM",
        status: "active",
        laterality: "right",
        severity: "mild",
        stage: null,
        onset_date: "2022-01-09",
        resolved_date: null,
        external_id: "ccda:condition:M17.9:right",
      },
      {
        name: "Invasive ductal carcinoma",
        code: "C50.911",
        code_system: "ICD-10-CM",
        status: "active",
        laterality: null,
        severity: null,
        stage: "Stage IIIA",
        onset_date: "2020-02-02",
        resolved_date: null,
        external_id: "ccda:condition:C50.911",
      },
    ],
    familyHistory: [
      {
        relation: "Father",
        condition: "Coronary artery disease",
        code: "53741008",
        code_system: "SNOMED CT",
        onset_age: 48,
        deceased: 1,
        age_at_death: 52,
        cause_of_death: "Myocardial infarction",
        relation_type: "genetic",
        lineage: null,
        external_id: "ccda:famhx:father:53741008",
      },
    ],
  });

  // Manual rows for the risk profile: an ADOPTED father with cardiac disease (must
  // not weigh as hereditary) and a genetic mother whose CAUSE OF DEATH is the only
  // place her cardiac history is recorded.
  const fam = db.prepare(
    `INSERT INTO family_history
       (profile_id, relation, condition, code, code_system, onset_age, deceased,
        age_at_death, cause_of_death, relation_type, lineage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  fam.run(
    pRisk,
    "Father",
    "Coronary artery disease",
    null,
    null,
    50,
    0,
    null,
    null,
    "adopted",
    null
  );
  fam.run(
    pRisk,
    "Grandmother",
    "Cataract",
    null,
    null,
    70,
    1,
    74,
    "Colorectal cancer",
    "genetic",
    "maternal"
  );
});

describe("migrations 144/145 — the columns and their CHECK sets", () => {
  it("conditions carries laterality / severity / stage", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(conditions)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["laterality", "severity", "stage"])
    );
  });

  it("family_history carries the death facts and the genetic axis", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(family_history)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "age_at_death",
        "cause_of_death",
        "relation_type",
        "lineage",
      ])
    );
  });

  it("rejects an off-vocabulary laterality / relation_type at the DB level", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO conditions (profile_id, name, laterality) VALUES (?,?,?)`
        )
        .run(pImport, "Bad side", "sideways")
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO family_history (profile_id, condition, relation_type)
           VALUES (?,?,?)`
        )
        .run(pImport, "Bad axis", "foster")
    ).toThrow(/CHECK/i);
  });
});

describe("import path retains the condition attributes (#1403)", () => {
  it("stores the side, the grade and the stage the document carried", () => {
    const rows = getConditions(pImport);
    const left = rows.find((c) => c.laterality === "left")!;
    expect(left).toMatchObject({
      name: "Osteoarthritis of knee",
      severity: "moderate",
    });
    const staged = rows.find((c) => c.name.startsWith("Invasive"))!;
    expect(staged.stage).toBe("Stage IIIA");
    expect(staged.laterality).toBeNull();
    expect(staged.severity).toBeNull();
  });

  it("keeps both sides of a same-name, same-code pair (laterality is identity)", () => {
    // Before #1403 these two collapsed onto one representative and a knee vanished.
    const knees = getConditions(pImport).filter((c) =>
      c.name.startsWith("Osteoarthritis")
    );
    expect(knees.map((c) => c.laterality).sort()).toEqual(["left", "right"]);
  });
});

describe("import path retains the family-history facts (#1407)", () => {
  it("stores the age at death, the cause and the genetic axis", () => {
    const f = getFamilyHistory(pImport)[0];
    expect(f).toMatchObject({
      relation: "Father",
      deceased: 1,
      age_at_death: 52,
      cause_of_death: "Myocardial infarction",
      relation_type: "genetic",
    });
  });
});

describe("the risk gather reads the genetic discriminator (#1407)", () => {
  it("an adopted parent's cardiac history does not become a hereditary factor", () => {
    const factors = getRiskFactors(pRisk);
    // The ONLY cardiovascular row on this profile is the adopted father's.
    expect(factors.has("family-cardiovascular")).toBe(false);
  });

  it("a genetic relative's cause of death reaches the cadence engine", () => {
    // The grandmother's stored CONDITION is a cataract; her colorectal cancer is
    // recorded only as the cause of death, with age_at_death 74 as its onset proxy.
    const factors = getRiskFactors(pRisk);
    expect(factors.has("family-colorectal")).toBe(true);
    expect(factors.has("family-colorectal-early-onset")).toBe(false);
  });
});
