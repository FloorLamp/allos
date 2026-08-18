// DB INTEGRATION TIER — #2737's forward rename of the canonical result registry.
//
// The migration changes the persistence name only. This fixture carries both a
// curated definition and an AI-coined definition, including structured range data,
// so the test proves that an established database keeps its rows and constraints.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260814-canonical-result-definitions";

describe("canonical result definition registry migration", () => {
  it("preserves definitions, provenance, ranges, and case-insensitive identity", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE canonical_biomarkers (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        category TEXT,
        unit TEXT,
        ref_low REAL,
        optimal_high REAL,
        direction TEXT,
        ranges_by_age TEXT,
        conversions TEXT,
        source TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = db.prepare(`
      INSERT INTO canonical_biomarkers
        (name, category, unit, ref_low, optimal_high, direction,
         ranges_by_age, conversions, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "Hemoglobin A1c",
      "lab",
      "%",
      4,
      5.4,
      "lower_better",
      '[{"min_age":0,"max_age":18,"ref_low":4,"ref_high":5.6}]',
      '{"mmol/mol":0.0915}',
      "seed",
      "2026-08-01 10:20:30"
    );
    insert.run(
      "Provider Comment Score",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "ai",
      "2026-08-02 11:22:33"
    );

    up(db);

    expect(
      db
        .prepare(
          `SELECT name, category, unit, ref_low, optimal_high, direction,
                  ranges_by_age, conversions, source, created_at
             FROM canonical_result_definitions
            ORDER BY name`
        )
        .all()
    ).toEqual([
      {
        name: "Hemoglobin A1c",
        category: "lab",
        unit: "%",
        ref_low: 4,
        optimal_high: 5.4,
        direction: "lower_better",
        ranges_by_age:
          '[{"min_age":0,"max_age":18,"ref_low":4,"ref_high":5.6}]',
        conversions: '{"mmol/mol":0.0915}',
        source: "seed",
        created_at: "2026-08-01 10:20:30",
      },
      {
        name: "Provider Comment Score",
        category: null,
        unit: null,
        ref_low: null,
        optimal_high: null,
        direction: null,
        ranges_by_age: null,
        conversions: null,
        source: "ai",
        created_at: "2026-08-02 11:22:33",
      },
    ]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO canonical_result_definitions (name) VALUES ('hemoglobin a1c')"
        )
        .run()
    ).toThrow(/UNIQUE constraint failed/);

    db.close();
  });
});
