// DB INTEGRATION TIER — migration 185 (#2479 part 2): retiring the persisted
// `medical_records.category = 'biomarker'` catch-all.
//
// Driven against a MINIMAL pre-migration schema (the 165/171/174/177/180 pattern), so
// every claim is about the pass and not about whatever else the baseline supplies. The
// tables created here are exactly the ones the pass reads: the rows, the vocabulary
// that classifies them, and the FK children whose links must survive.
//
// The fixture is a database in the state #2479 describes: one profile whose legacy
// bucket holds a real lab analyte, a VO2 Max written there by an integration, a
// screening TOTAL, an immutable fact, and two rows nothing can classify — an ai-coined
// vocabulary entry with no category, and a name the vocabulary has never heard of.
// Beside them sit rows in other categories that must not move at all.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ASSIGNABLE_MEDICAL_CATEGORIES,
  MEDICAL_CATEGORIES,
  NON_IDENTITY_CATEGORIES,
  RETIRED_MEDICAL_CATEGORIES,
  carriesResultIdentity,
} from "@/lib/medical-categories";
import {
  RECLASS_TARGET_CATEGORIES,
  reclassifyLegacyBiomarkerCategory,
} from "@/lib/legacy-category-reclass-db";
import { up } from "@/lib/migrations/versions/185-legacy-biomarker-category";

const DATE = "2017-03-14";

// The vocabulary as a real database carries it: curated entries with a category, plus
// an ai-coined row that has none (lib/queries/medical.ts coins `(name, source='ai')`).
const VOCAB: { name: string; category: string | null; source: string }[] = [
  { name: "Homocysteine", category: "lab", source: "seed" },
  { name: "VO2 Max", category: "vitals", source: "seed" },
  { name: "PHQ-9", category: "instrument", source: "seed" },
  { name: "ABO Blood Group", category: "reference", source: "seed" },
  { name: "Bone Mineral Density", category: "scan", source: "seed" },
  // Coined by an AI import, so it states no category — no evidence, so no move.
  { name: "Provider Comment Score", category: null, source: "ai" },
];

interface Seed {
  id: number;
  profileId?: number;
  category: string;
  name: string;
  canonical?: string | null;
}

// The pre-185 shape: the live post-177 category CHECK, the columns the pass reads, and
// the two FK children whose links the pass must leave resolved.
function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE canonical_biomarkers (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      category TEXT,
      source TEXT NOT NULL DEFAULT 'ai'
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription','instrument','derived','reference','report','assessment')),
      name TEXT NOT NULL,
      value TEXT,
      value_num REAL,
      unit TEXT,
      flag TEXT,
      canonical_name TEXT
    );
    CREATE TABLE care_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      source_medical_record_id INTEGER REFERENCES medical_records(id),
      resolved_by_medical_record_id INTEGER REFERENCES medical_records(id)
    );
    CREATE TABLE intake_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      source_record_id INTEGER REFERENCES medical_records(id)
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Fixture One')")
    .run();
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (2, 'Fixture Two')")
    .run();
  const vocab = mem.prepare(
    "INSERT INTO canonical_biomarkers (name, category, source) VALUES (?, ?, ?)"
  );
  for (const v of VOCAB) vocab.run(v.name, v.category, v.source);
  return mem;
}

function insert(mem: Database.Database, rows: Seed[]): void {
  const stmt = mem.prepare(
    `INSERT INTO medical_records
       (id, profile_id, date, category, name, value, value_num, unit, flag, canonical_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unit', 'normal', ?)`
  );
  for (const r of rows)
    stmt.run(
      r.id,
      r.profileId ?? 1,
      DATE,
      r.category,
      r.name,
      "7",
      7,
      r.canonical === undefined ? r.name : r.canonical
    );
}

function categories(mem: Database.Database): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of mem
    .prepare("SELECT id, category FROM medical_records ORDER BY id")
    .all() as { id: number; category: string }[])
    out[r.id] = r.category;
  return out;
}

describe("migration 185 re-files the legacy biomarker catch-all (#2479)", () => {
  it("takes each row's target from the canonical registry's own category", () => {
    const mem = preMigrationDb();
    insert(mem, [
      { id: 1, category: "biomarker", name: "Homocysteine" },
      { id: 2, category: "biomarker", name: "VO2 Max" },
      { id: 3, category: "biomarker", name: "PHQ-9" },
      { id: 4, category: "biomarker", name: "ABO Blood Group" },
      { id: 5, category: "biomarker", name: "Bone Mineral Density" },
    ]);
    up(mem);
    expect(categories(mem)).toEqual({
      1: "lab",
      2: "vitals",
      3: "instrument",
      4: "reference",
      5: "scan",
    });
  });

  it("matches on canonical_name when the printed name differs, NOCASE", () => {
    const mem = preMigrationDb();
    insert(mem, [
      // The lab printed an abbreviation; the identity is the canonical name.
      { id: 1, category: "biomarker", name: "HCY", canonical: "homocysteine" },
      // No canonical name at all — the printed name is the identity.
      { id: 2, category: "biomarker", name: "vo2 max", canonical: null },
    ]);
    up(mem);
    expect(categories(mem)).toEqual({ 1: "lab", 2: "vitals" });
  });

  it("leaves a row the registry cannot classify exactly where it is, and reports it", () => {
    const mem = preMigrationDb();
    insert(mem, [
      // Registered, but by an AI import that stated no category — no evidence.
      { id: 1, category: "biomarker", name: "Provider Comment Score" },
      // Not in the vocabulary at all.
      { id: 2, category: "biomarker", name: "Mystery Index" },
      { id: 3, category: "biomarker", name: "Mystery Index" },
      { id: 4, category: "biomarker", name: "Homocysteine" },
    ]);
    const report = reclassifyLegacyBiomarkerCategory(mem);
    expect(categories(mem)).toEqual({
      1: "biomarker",
      2: "biomarker",
      3: "biomarker",
      4: "lab",
    });
    expect(report.moved).toEqual({ lab: 1 });
    expect(report.residue).toEqual([
      { identity: "Mystery Index", rows: 2 },
      { identity: "Provider Comment Score", rows: 1 },
    ]);
  });

  it("touches no row in any other category", () => {
    const mem = preMigrationDb();
    insert(mem, [
      { id: 1, category: "lab", name: "Homocysteine" },
      { id: 2, category: "assessment", name: "VO2 Max" },
      { id: 3, category: "report", name: "PHQ-9" },
      { id: 4, category: "vitals", name: "ABO Blood Group" },
    ]);
    const before = categories(mem);
    up(mem);
    expect(categories(mem)).toEqual(before);
  });

  it("changes only the category — never the value, flag, name or identity", () => {
    const mem = preMigrationDb();
    insert(mem, [{ id: 1, category: "biomarker", name: "Homocysteine" }]);
    const before = mem
      .prepare(
        "SELECT name, value, value_num, unit, flag, canonical_name, date, profile_id FROM medical_records WHERE id = 1"
      )
      .get();
    up(mem);
    expect(
      mem
        .prepare(
          "SELECT name, value, value_num, unit, flag, canonical_name, date, profile_id FROM medical_records WHERE id = 1"
        )
        .get()
    ).toEqual(before);
  });

  it("moves each profile's own rows and never reaches across profiles", () => {
    const mem = preMigrationDb();
    insert(mem, [
      { id: 1, profileId: 1, category: "biomarker", name: "Homocysteine" },
      { id: 2, profileId: 2, category: "biomarker", name: "VO2 Max" },
    ]);
    const report = reclassifyLegacyBiomarkerCategory(mem);
    expect(categories(mem)).toEqual({ 1: "lab", 2: "vitals" });
    expect(report.moved).toEqual({ lab: 1, vitals: 1 });
  });

  it("keeps every child FK link resolved — nothing is deleted and no id moves (#2444)", () => {
    const mem = preMigrationDb();
    insert(mem, [
      { id: 1, category: "biomarker", name: "Homocysteine" },
      { id: 2, category: "biomarker", name: "Mystery Index" },
    ]);
    mem
      .prepare(
        `INSERT INTO care_plan_items
           (id, profile_id, description, source_medical_record_id, resolved_by_medical_record_id)
         VALUES (1, 1, 'Recheck homocysteine', 1, 2)`
      )
      .run();
    mem
      .prepare(
        "INSERT INTO intake_items (id, profile_id, name, source_record_id) VALUES (1, 1, 'Methylfolate', 1)"
      )
      .run();
    up(mem);
    mem.pragma("foreign_keys = ON");
    expect(mem.pragma("foreign_key_check")).toEqual([]);
    expect(
      mem
        .prepare(
          "SELECT source_medical_record_id AS s, resolved_by_medical_record_id AS r FROM care_plan_items WHERE id = 1"
        )
        .get()
    ).toEqual({ s: 1, r: 2 });
    expect(
      mem
        .prepare("SELECT source_record_id AS s FROM intake_items WHERE id = 1")
        .get()
    ).toEqual({ s: 1 });
  });

  it("is idempotent — a second run finds only the residue and writes nothing", () => {
    const mem = preMigrationDb();
    insert(mem, [
      { id: 1, category: "biomarker", name: "Homocysteine" },
      { id: 2, category: "biomarker", name: "Mystery Index" },
    ]);
    up(mem);
    const after = categories(mem);
    const second = reclassifyLegacyBiomarkerCategory(mem);
    expect(categories(mem)).toEqual(after);
    expect(second.moved).toEqual({});
    expect(second.residue).toEqual([{ identity: "Mystery Index", rows: 1 }]);
  });

  it("does nothing at all on a database with no legacy rows", () => {
    const mem = preMigrationDb();
    insert(mem, [{ id: 1, category: "lab", name: "Homocysteine" }]);
    const report = reclassifyLegacyBiomarkerCategory(mem);
    expect(report).toEqual({ moved: {}, residue: [] });
  });
});

describe("the frozen reclass targets, against the migrated schema", () => {
  it("every target is a legal medical category", () => {
    for (const target of RECLASS_TARGET_CATEGORIES)
      expect(MEDICAL_CATEGORIES as readonly string[]).toContain(target);
  });

  it("every target carries result identity — the pass never strips one", () => {
    for (const target of RECLASS_TARGET_CATEGORIES) {
      expect(carriesResultIdentity(target)).toBe(true);
      expect(NON_IDENTITY_CATEGORIES as readonly string[]).not.toContain(
        target
      );
    }
  });

  it("no target is itself retired", () => {
    for (const target of RECLASS_TARGET_CATEGORIES)
      expect(RETIRED_MEDICAL_CATEGORIES as readonly string[]).not.toContain(
        target
      );
  });

  it("the live CHECK still admits the retired value, so residue can be stored and read", () => {
    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'"
        )
        .get() as { sql: string }
    ).sql;
    for (const retired of RETIRED_MEDICAL_CATEGORIES)
      expect(sql).toContain(`'${retired}'`);
  });

  it("the assignable set is the enum minus the retired values", () => {
    expect(ASSIGNABLE_MEDICAL_CATEGORIES).toEqual(
      MEDICAL_CATEGORIES.filter(
        (c) => !(RETIRED_MEDICAL_CATEGORIES as readonly string[]).includes(c)
      )
    );
    expect(ASSIGNABLE_MEDICAL_CATEGORIES).not.toContain("biomarker");
  });
});
