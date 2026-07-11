// DB INTEGRATION TIER — the Biomarkers table's free-text search must match the
// CANONICAL name (the row heading it renders), not only the raw lab string and
// panel (#383). A record imported as "CHOLESTEROL, TOTAL" and displayed as "Total
// Cholesterol" must be findable by "total cholesterol"; the raw string still
// matches too. Mirrors the JS twin in lib/derived-table (filterDerivedForTable).
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic
// values only (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { getMedicalRecords } from "@/lib/queries";
import { db } from "@/lib/db";

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('BIOMARKER-SEARCH')").run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit)
     VALUES (?, '2024-05-01', 'lab', 'CHOLESTEROL, TOTAL', 'Total Cholesterol', '180', 180, 'mg/dL')`
  ).run(profileId);
});

describe("getMedicalRecords free-text search matches the canonical name (#383)", () => {
  it("finds a row by its displayed canonical heading", () => {
    const rows = getMedicalRecords(profileId, { q: "total cholesterol" });
    expect(rows.map((r) => r.canonical_name)).toContain("Total Cholesterol");
  });

  it("still finds a row by the raw lab string", () => {
    const rows = getMedicalRecords(profileId, { q: "cholesterol, total" });
    expect(rows.map((r) => r.name)).toContain("CHOLESTEROL, TOTAL");
  });

  it("does not match unrelated text", () => {
    const rows = getMedicalRecords(profileId, { q: "glucose" });
    expect(rows).toHaveLength(0);
  });
});
