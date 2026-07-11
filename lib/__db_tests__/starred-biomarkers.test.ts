// DB INTEGRATION TIER — the pinned starred-biomarker tile must agree with the
// detail page and the Biomarkers table about the same analyte (#381):
//
//   1. getStarredBiomarkers carries the LATEST RECORD's category (not the
//      canonical entry's), so the tile can fire the never-stale genomics rule the
//      detail page/table already honor.
//   2. The "latest reading" is chosen over the DE-DUPED id set (manual preferred),
//      so a manual reading plus its higher-id imported twin surface the MANUAL
//      representative's flag — the same one getBiomarkerSeries/getMedicalRecords
//      show — not the imported twin's.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. All values
// are SYNTHETIC (no PHI).

import { describe, it, expect } from "vitest";
import { getStarredBiomarkers } from "@/lib/queries";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function star(profileId: number, canonical: string): void {
  db.prepare(
    "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)"
  ).run(profileId, canonical);
}

interface RecordSpec {
  date: string;
  category: string;
  name: string;
  canonical: string;
  value: string | null;
  valueNum: number | null;
  unit: string | null;
  flag: string | null;
  documentId: number | null;
}

function insertRecord(profileId: number, r: RecordSpec): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit, flag, document_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        profileId,
        r.date,
        r.category,
        r.name,
        r.canonical,
        r.value,
        r.valueNum,
        r.unit,
        r.flag,
        r.documentId
      ).lastInsertRowid
  );
}

describe("getStarredBiomarkers agrees with the detail page/table (#381)", () => {
  it("carries the latest RECORD's category (genomics never goes stale on the tile)", () => {
    const p = newProfile("genomics-star");
    star(p, "APOE Genotype");
    insertRecord(p, {
      date: "2022-01-01",
      category: "genomics",
      name: "APOE Genotype",
      canonical: "APOE Genotype",
      value: "e3/e4",
      valueNum: null,
      unit: null,
      flag: null,
      documentId: null,
    });
    const [s] = getStarredBiomarkers(p);
    expect(s.latest_category).toBe("genomics");
  });

  it("prefers the MANUAL representative's flag over a higher-id imported twin", () => {
    const p = newProfile("dedup-flag-star");
    star(p, "Total Cholesterol");
    // Manual reading (document_id NULL, no lab flag), then a content-identical
    // imported twin with a HIGHER id and a lab 'high' flag. Dedup keeps the manual
    // one, so the tile must show its (null) flag — not the imported twin's.
    insertRecord(p, {
      date: "2024-03-01",
      category: "lab",
      name: "Cholesterol, Total",
      canonical: "Total Cholesterol",
      value: "180",
      valueNum: 180,
      unit: "mg/dL",
      flag: null,
      documentId: null,
    });
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
           VALUES (?, 'labs.pdf', '', 'done')`
        )
        .run(p).lastInsertRowid
    );
    insertRecord(p, {
      date: "2024-03-01",
      category: "lab",
      name: "Cholesterol, Total",
      canonical: "Total Cholesterol",
      value: "180",
      valueNum: 180,
      unit: "mg/dL",
      flag: "high",
      documentId: docId,
    });
    const [s] = getStarredBiomarkers(p);
    expect(s.latest_flag).toBeNull();
    expect(s.latest_value).toBe("180");
  });
});
