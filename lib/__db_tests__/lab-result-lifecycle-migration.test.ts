import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/120-lab-result-lifecycle";

// Migration 120 (#1404) against a minimal pre-migration schema: the four added
// columns, the vocabulary CHECKs that keep a bad status/fasting value out, the
// correction-lineage child table, and its ON DELETE CASCADE. Replay-safe (every step
// is guarded), which the non-version-gated migration wrapper relies on.

function freshDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT,
      unit TEXT,
      provider_id INTEGER
    );
    INSERT INTO medical_records (id, profile_id, date, category, name, value, unit)
      VALUES (5, 1, '2026-01-09', 'lab', 'Potassium', '5.2', 'mmol/L');
  `);
  return mem;
}

function columns(mem: Database.Database, table: string): string[] {
  return (
    mem.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  )
    .map((c) => c.name)
    .sort();
}

describe("migration 120 — lab result lifecycle", () => {
  it("adds the lifecycle + collection columns without touching existing rows", () => {
    const mem = freshDb();
    up(mem);
    up(mem); // replay is a pure no-op

    const cols = columns(mem, "medical_records");
    for (const c of [
      "result_status",
      "fasting",
      "specimen",
      "ordering_provider_id",
    ])
      expect(cols, `missing ${c}`).toContain(c);

    // A legacy reading keeps its value and states NOTHING about the new attributes —
    // unstated, never a guessed 'final' / non-fasting.
    expect(
      mem
        .prepare(
          `SELECT value, result_status, fasting, specimen, ordering_provider_id
             FROM medical_records WHERE id = 5`
        )
        .get()
    ).toEqual({
      value: "5.2",
      result_status: null,
      fasting: null,
      specimen: null,
      ordering_provider_id: null,
    });
  });

  it("pins the status and fasting vocabularies with CHECKs", () => {
    const mem = freshDb();
    up(mem);
    const setStatus = (v: string) =>
      mem
        .prepare("UPDATE medical_records SET result_status = ? WHERE id = 5")
        .run(v);
    for (const ok of ["preliminary", "final", "corrected", "amended"])
      expect(() => setStatus(ok)).not.toThrow();
    expect(() => setStatus("registered")).toThrow();
    expect(() => setStatus("Corrected")).toThrow();

    const setFasting = (v: number) =>
      mem.prepare("UPDATE medical_records SET fasting = ? WHERE id = 5").run(v);
    expect(() => setFasting(1)).not.toThrow();
    expect(() => setFasting(0)).not.toThrow();
    expect(() => setFasting(2)).toThrow();
  });

  it("creates the correction-lineage child table, cascading from its reading", () => {
    const mem = freshDb();
    up(mem);
    mem.pragma("foreign_keys = ON");

    expect(columns(mem, "medical_record_revisions")).toEqual(
      [
        "date",
        "flag",
        "id",
        "record_id",
        "reference_range",
        "result_status",
        "source",
        "superseded_at",
        "superseded_by_status",
        "unit",
        "value",
        "value_num",
      ].sort()
    );
    // No profile_id of its own: it is a CHILD, reached through record_id.
    expect(columns(mem, "medical_record_revisions")).not.toContain(
      "profile_id"
    );

    mem
      .prepare(
        `INSERT INTO medical_record_revisions (record_id, value, value_num, unit)
         VALUES (5, '5.2', 5.2, 'mmol/L')`
      )
      .run();
    // A revision of a reading that doesn't exist is refused by the FK.
    expect(() =>
      mem
        .prepare(
          "INSERT INTO medical_record_revisions (record_id, value) VALUES (999, '1')"
        )
        .run()
    ).toThrow();

    mem.prepare("DELETE FROM medical_records WHERE id = 5").run();
    expect(
      (
        mem
          .prepare("SELECT COUNT(*) AS n FROM medical_record_revisions")
          .get() as { n: number }
      ).n
    ).toBe(0);
  });
});
