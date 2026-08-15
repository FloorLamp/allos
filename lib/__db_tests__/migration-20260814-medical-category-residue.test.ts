import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260814-medical-category-residue";

function beforeRetirement(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  const target = MIGRATIONS.findIndex(
    (migration) => migration.name === "20260814-medical-category-residue"
  );
  if (target < 0) throw new Error("medical category migration is not registered");
  for (const migration of MIGRATIONS.slice(0, target)) migration.up(mem);
  return mem;
}

describe("#2877 legacy medical category retirement", () => {
  it("classifies from authority and presents unresolved rows without moving identity or links", () => {
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
      .prepare(
        `INSERT INTO saved_items (profile_id, kind, key, backed)
       VALUES (1, 'clinical-result', 'Provider Comment Score', 1)`
      )
      .run();
    mem
      .prepare(
        `INSERT INTO upcoming_dismissals
         (profile_id, signal_key, dismissed_at)
       VALUES (1, 'biomarker:Provider Comment Score', '2020-04-06')`
      )
      .run();

    up(mem);

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
    expect(
      mem.prepare("SELECT kind, key, backed FROM saved_items").get()
    ).toEqual({
      kind: "clinical-result",
      key: "Provider Comment Score",
      backed: 1,
    });
    expect(
      mem
        .prepare("SELECT signal_key, dismissed_at FROM upcoming_dismissals")
        .get()
    ).toEqual({
      signal_key: "biomarker:Provider Comment Score",
      dismissed_at: "2020-04-06",
    });
  });

  it("rebuilds the category contract, indexes, sequence, and foreign keys replay-safely", () => {
    const mem = beforeRetirement();
    mem
      .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Schema review')")
      .run();
    mem
      .prepare(
        `INSERT INTO medical_records
         (id, profile_id, date, category, name)
       VALUES (99, 1, '2020-04-05', 'biomarker', 'Unknown')`
      )
      .run();
    mem.prepare("DELETE FROM medical_records WHERE id = 99").run();

    up(mem);
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
    expect(() => up(mem)).not.toThrow();
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check")).toEqual([]);
  });
});
