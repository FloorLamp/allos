// DB INTEGRATION TIER — migration 180 (#2322): re-pointing the waist-circumference
// readings already on disk onto the `waist-circ` metric the same change created.
//
// WHAT IS ACTUALLY AT STAKE. The change declares the slug REACHABLE in
// METRIC_DOCUMENT_REACH, which removes "Waist Circumference" from the flat Biomarkers
// browser. A row already stored in `medical_records` would therefore leave the catalog
// WITHOUT arriving on the chart — the stranding that registry exists to prevent. This
// suite is the proof that the migration closes that window: the value lands in
// `metric_samples`, the twin row goes, and the name-keyed side-state goes with it.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171/174/176
// pattern), so every claim is about the migration and not about whatever else the
// baseline provides.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/180-waist-circumference-metric";

const DATE = "2017-03-09";
const OTHER_DATE = "2017-04-11";

interface SampleRow {
  profile_id: number;
  date: string;
  value: number;
  source: string | null;
}

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT,
      name TEXT,
      canonical_name TEXT,
      value TEXT,
      value_num REAL,
      unit TEXT,
      loinc TEXT,
      source TEXT
    );
    CREATE TABLE metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      metric TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      value REAL NOT NULL
    );
    CREATE TABLE canonical_biomarkers (
      name TEXT PRIMARY KEY,
      source TEXT
    );
    CREATE TABLE saved_items (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL
    );
    CREATE TABLE coverage_gaps (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL
    );
    CREATE TABLE upcoming_dismissals (
      profile_id INTEGER NOT NULL, signal_key TEXT NOT NULL
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'A'), (2, 'B')")
    .run();
  const rec = mem.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit,
        loinc, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Profile 1 — the ordinary imported reading, in cm.
  rec.run(
    1,
    DATE,
    "vitals",
    "WAIST CIRCUMFERENCE",
    "Waist Circumference",
    "84",
    84,
    "cm",
    null,
    "document:7"
  );
  // …and one reported in inches, which converts.
  rec.run(
    1,
    OTHER_DATE,
    "vitals",
    "Waist Girth",
    null,
    "34",
    34,
    "in",
    null,
    "document:7"
  );
  // A waist/hip RATIO: a unitless ratio is never a length, and its LOINC says so.
  rec.run(
    1,
    DATE,
    "vitals",
    "Waist/Hip Ratio",
    "Waist-Hip Ratio",
    "0.9",
    0.9,
    null,
    "60803-4",
    "document:7"
  );
  // A waist row with NO unit — ambiguous, so the converter refuses and the record
  // stays exactly as an ingest would have left it.
  rec.run(
    1,
    "2017-05-01",
    "vitals",
    "Waist Circumference",
    "Waist Circumference",
    "34",
    34,
    null,
    null,
    "document:7"
  );
  // A neighbour that merely contains the word: untouched.
  rec.run(
    1,
    DATE,
    "vitals",
    "Head Circumference",
    "Head Circumference",
    "47",
    47,
    "cm",
    null,
    "document:7"
  );
  // A second profile's waist reading, recognized by LOINC under a generic name.
  rec.run(
    2,
    DATE,
    "vitals",
    "Measurement",
    null,
    "92",
    92,
    "cm",
    "8280-0",
    null
  );
  // The name-keyed state a stored waist reading accumulates.
  mem
    .prepare("INSERT INTO canonical_biomarkers (name, source) VALUES (?, 'ai')")
    .run("Waist Circumference");
  mem
    .prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (1, 'biomarker', ?)"
    )
    .run("Waist Circumference");
  mem
    .prepare(
      "INSERT INTO coverage_gaps (profile_id, kind, item_key) VALUES (1, 'biomarker', ?)"
    )
    .run("waist circumference");
  mem
    .prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key) VALUES (1, ?)"
    )
    .run("biomarker:waist circumference");
  return mem;
}

function samples(mem: Database.Database): SampleRow[] {
  return mem
    .prepare(
      `SELECT profile_id, date, value, source FROM metric_samples
        WHERE metric = 'waist_circumference_cm'
        ORDER BY profile_id, date`
    )
    .all() as SampleRow[];
}

function recordNames(mem: Database.Database, profileId: number): string[] {
  return (
    mem
      .prepare(
        "SELECT name FROM medical_records WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as { name: string }[]
  ).map((r) => r.name);
}

describe("migration 180 — waist circumference becomes a metric sample", () => {
  it("projects every recognized reading into metric_samples, converting units", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(samples(mem)).toEqual([
      { profile_id: 1, date: DATE, value: 84, source: "document:7" },
      { profile_id: 1, date: OTHER_DATE, value: 86.4, source: "document:7" },
      // Recognized by LOINC under a generic display name; a NULL record source
      // becomes the manual provenance the sample column requires.
      { profile_id: 2, date: DATE, value: 92, source: "manual" },
    ]);
  });

  it("deletes the moved twin so the reading lives in exactly one place", () => {
    // The forward path (`withoutCapturedWaistCircs`) drops the record when a sample is
    // stored; converging to a different state here would be a second source of truth.
    const mem = preMigrationDb();
    up(mem);
    expect(recordNames(mem, 1)).toEqual([
      "Waist/Hip Ratio",
      // The unit-less waist row: no sample was stored for it, so it stays a record —
      // exactly what an ingest would have done with the same value.
      "Waist Circumference",
      "Head Circumference",
    ]);
    expect(recordNames(mem, 2)).toEqual([]);
  });

  it("leaves the ratio and the head-circumference neighbour alone", () => {
    const mem = preMigrationDb();
    up(mem);
    const others = mem
      .prepare(
        `SELECT COUNT(*) AS n FROM metric_samples
          WHERE metric != 'waist_circumference_cm'`
      )
      .get() as { n: number };
    expect(others.n).toBe(0);
  });

  it("KEEPS the side-state while a record still carries the name", () => {
    // The fixture's unit-less row is unconvertible, so it stays a `medical_records`
    // reading under the same name — and the sweep's condition is exactly "no
    // identity-carrying row is left", not "the migration ran". A ★ or a snooze whose
    // subject still exists is not orphaned.
    const mem = preMigrationDb();
    up(mem);
    const count = (sql: string): number =>
      (mem.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM saved_items")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM coverage_gaps")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM upcoming_dismissals")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(1);
  });

  it("sweeps the name-keyed side-state once nothing carries the name", () => {
    const mem = preMigrationDb();
    // Give the unit-less row a real unit, so every waist reading converts and moves.
    mem
      .prepare(
        "UPDATE medical_records SET unit = 'cm', value_num = 85 WHERE unit IS NULL AND name = 'Waist Circumference'"
      )
      .run();
    up(mem);
    const count = (sql: string): number =>
      (mem.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM saved_items")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM coverage_gaps")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM upcoming_dismissals")).toBe(0);
    // The ai-coined vocabulary row — what put it under Data → Coverage.
    expect(count("SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(0);
  });

  it("never deletes a CURATED vocabulary row", () => {
    const mem = preMigrationDb();
    mem
      .prepare(
        "UPDATE medical_records SET unit = 'cm', value_num = 85 WHERE unit IS NULL AND name = 'Waist Circumference'"
      )
      .run();
    mem
      .prepare("UPDATE canonical_biomarkers SET source = 'seed' WHERE name = ?")
      .run("Waist Circumference");
    up(mem);
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS n FROM canonical_biomarkers").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  it("defers to a sample another source already stored for that date", () => {
    const mem = preMigrationDb();
    mem
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (1, 'manual', 'waist_circumference_cm', ?, ?, ?, 80)`
      )
      .run(DATE, DATE, DATE);
    up(mem);
    const day1 = samples(mem).filter(
      (s) => s.profile_id === 1 && s.date === DATE
    );
    // The manual tape reading is never overwritten or doubled.
    expect(day1).toEqual([
      { profile_id: 1, date: DATE, value: 80, source: "manual" },
    ]);
  });

  it("is idempotent — a second run finds nothing left to move", () => {
    const mem = preMigrationDb();
    up(mem);
    const after = samples(mem);
    up(mem);
    expect(samples(mem)).toEqual(after);
  });

  it("runs on a database that has no waist reading at all", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        date TEXT NOT NULL, category TEXT, name TEXT, canonical_name TEXT,
        value TEXT, value_num REAL, unit TEXT, loinc TEXT, source TEXT
      );
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        source TEXT NOT NULL, metric TEXT NOT NULL, date TEXT NOT NULL,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, value REAL NOT NULL
      );
      CREATE TABLE canonical_biomarkers (name TEXT PRIMARY KEY, source TEXT);
      CREATE TABLE saved_items (profile_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL);
      CREATE TABLE coverage_gaps (profile_id INTEGER NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL);
      CREATE TABLE upcoming_dismissals (profile_id INTEGER NOT NULL, signal_key TEXT NOT NULL);
      INSERT INTO profiles (id, name) VALUES (1, 'A');
    `);
    expect(() => up(mem)).not.toThrow();
    expect(samples(mem)).toEqual([]);
  });
});
