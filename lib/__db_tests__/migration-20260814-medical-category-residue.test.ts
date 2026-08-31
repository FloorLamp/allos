import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up as renameCanonicalRegistry } from "@/lib/migrations/versions/20260814-canonical-result-definitions";
import { up as retireCategory } from "@/lib/migrations/versions/20260814-medical-category-residue";

const MEDICAL_SCHEMA_IDS = new Set([
  1, 2, 28, 34, 37, 60, 81, 86, 90, 106, 113, 120, 165, 177, 185,
]);

function beforeRetirement(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const migration of NUMBERED_MIGRATIONS) {
    if (MEDICAL_SCHEMA_IDS.has(migration.id)) migration.up(mem);
  }
  renameCanonicalRegistry(mem);
  return mem;
}

describe("#2877 legacy medical category retirement", () => {
  it("classifies rows and rebuilds the category contract without identity or link loss", () => {
    const mem = beforeRetirement();
    mem
      .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Category review')")
      .run();
    mem
      .prepare(
        `INSERT INTO canonical_result_definitions (name, category, source)
         VALUES ('Homocysteine', 'lab', 'seed')`
      )
      .run();
    const insert = mem.prepare(
      `INSERT INTO medical_records
         (id, profile_id, date, category, name, canonical_name, value, unit,
          source, external_id, edited)
       VALUES (?, 1, '2020-04-05', 'biomarker', ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      41,
      "HCY",
      "Homocysteine",
      "9",
      "umol/L",
      "document",
      "known-41",
      0
    );
    insert.run(
      42,
      "Provider Comment Score",
      "Provider Comment Score",
      "7",
      "points",
      "document",
      "unknown-42",
      1
    );
    mem
      .prepare(
        `INSERT INTO medical_record_revisions
         (record_id, date, value, value_num, source)
       VALUES (42, '2020-04-04', '6', 6, 'document')`
      )
      .run();
    mem
      .prepare(
        `INSERT INTO care_plan_items
         (profile_id, description, source_medical_record_id,
          resolved_by_medical_record_id)
       VALUES (1, 'Review result', 41, 42)`
      )
      .run();
    mem
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, source_record_id)
       VALUES (1, 'Linked supplement', 42)`
      )
      .run();
    mem
      .prepare("INSERT INTO profiles (id, name) VALUES (2, 'Schema review')")
      .run();
    mem
      .prepare(
        `INSERT INTO medical_records
         (id, profile_id, date, category, name)
       VALUES (99, 2, '2020-04-05', 'biomarker', 'Unknown')`
      )
      .run();
    mem.prepare("DELETE FROM medical_records WHERE id = 99").run();

    retireCategory(mem);

    expect(
      mem
        .prepare(
          `SELECT id, category, name, canonical_name, value, unit, source,
                  external_id, edited
             FROM medical_records ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 41,
        category: "lab",
        name: "HCY",
        canonical_name: "Homocysteine",
        value: "9",
        unit: "umol/L",
        source: "document",
        external_id: "known-41",
        edited: 0,
      },
      {
        id: 42,
        category: null,
        name: "Provider Comment Score",
        canonical_name: "Provider Comment Score",
        value: "7",
        unit: "points",
        source: "document",
        external_id: "unknown-42",
        edited: 1,
      },
    ]);
    expect(
      mem
        .prepare(
          `SELECT source_medical_record_id AS sourceId,
                  resolved_by_medical_record_id AS resolvedId
             FROM care_plan_items`
        )
        .get()
    ).toEqual({ sourceId: 41, resolvedId: 42 });
    expect(
      mem.prepare("SELECT record_id FROM medical_record_revisions").get()
    ).toEqual({ record_id: 42 });
    expect(
      mem.prepare("SELECT source_record_id FROM intake_items").get()
    ).toEqual({ source_record_id: 42 });
    const sql = (
      mem
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'"
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("category TEXT");
    expect(sql).not.toContain("category TEXT NOT NULL");
    expect(sql).not.toContain("'biomarker'");
    expect(
      (
        mem
          .prepare(
            "SELECT seq FROM sqlite_sequence WHERE name = 'medical_records'"
          )
          .get() as { seq: number }
      ).seq
    ).toBe(99);
    expect(
      (
        mem
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master
              WHERE type = 'index' AND tbl_name = 'medical_records'
                AND name NOT LIKE 'sqlite_%'`
          )
          .get() as { n: number }
      ).n
    ).toBe(6);
    expect(() => retireCategory(mem)).not.toThrow();
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check")).toEqual([]);
    mem.close();
  });
});
