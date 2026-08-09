// DB INTEGRATION TIER — migration 177 (#2318): the `assessment` category and the
// one-shot re-homing of the CCD observations that were never measurements.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171/174 pattern),
// carrying the PRE-177 category CHECK, so every claim is about the migration and not
// about whatever else the baseline provides. The tables created here are exactly the
// ones the pass touches — which is also the checked list of "everything that took a
// NAME from these rows".
//
// The fixture is a database in the state the issue describes: one profile that
// imported a CCD carrying a temperature's body SITE, a vaccine LOT NUMBER and
// EXPIRY, a generic result-status word and a questionnaire ITEM, each of which
// acquired an ai-coined vocabulary row, a coverage gap, a star and a snooze. Beside
// them sit the rows that must NOT move: a genuinely scored numeric observation, a
// CODED qualitative lab (the same unitless/band-less SHAPE, which is exactly why the
// pass is conservative on the code axis), and a manually entered row.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values and an
// obviously-fake short lot string. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/177-assessment-category";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "@/lib/dismissal-keys";
import { biomarkerCoverageKey } from "@/lib/coverage-gaps";

const DATE = "2018-11-02";

// The names the defect coined, one per shape the issue lists.
const SITE = "Functional status";
const LOT = "Lot Number";
const EXPIRY = "Expiration Date";
const STATUS = "Result";
const ITEM = "Little interest or pleasure in doing things";
const NON_ANALYTES = [SITE, LOT, EXPIRY, STATUS, ITEM];

// The rows that must survive untouched.
const SCORED = "Mood Screen Score";
const QUALITATIVE = "Hepatitis B Surface Antigen";
const MANUAL = "Blood Type";

// The PRE-177 category CHECK, verbatim from migration 106.
const OLD_CHECK =
  "CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription','instrument','derived','reference','report'))";

interface Seed {
  profileId?: number;
  name: string;
  category?: string;
  externalId?: string | null;
  loinc?: string | null;
  value?: string | null;
  valueNum?: number | null;
  unit?: string | null;
  range?: string | null;
  flag?: string | null;
}

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    -- The FK PARENTS the rebuilt table declares. Empty is fine: what they prove is
    -- that a dangling nullable link is nulled before the FK'd copy.
    CREATE TABLE providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE medical_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL);
    CREATE TABLE encounters (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL);
    CREATE TABLE canonical_biomarkers (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      source TEXT NOT NULL DEFAULT 'ai'
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL ${OLD_CHECK},
      name TEXT NOT NULL,
      value TEXT,
      unit TEXT,
      reference_range TEXT,
      external_id TEXT,
      flag TEXT,
      value_num REAL,
      canonical_name TEXT,
      loinc TEXT,
      document_id INTEGER
    );
    CREATE TABLE saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(profile_id, kind, key)
    );
    CREATE TABLE upcoming_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      signal_key TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_upcoming_dismissals_key
      ON upcoming_dismissals(profile_id, signal_key);
    CREATE TABLE coverage_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      item_key TEXT NOT NULL COLLATE NOCASE,
      label TEXT NOT NULL,
      UNIQUE(profile_id, kind, item_key)
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'A'), (2, 'B')")
    .run();
  return mem;
}

function addRecord(mem: Database.Database, s: Seed): number {
  return Number(
    mem
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num,
            unit, reference_range, external_id, loinc, flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.profileId ?? 1,
        DATE,
        s.category ?? "lab",
        s.name,
        s.name,
        s.value ?? null,
        s.valueNum ?? null,
        s.unit ?? null,
        s.range ?? null,
        s.externalId === undefined
          ? `ccda:obs:${s.name.toLowerCase()}:${DATE}:x`
          : s.externalId,
        s.loinc ?? null,
        s.flag ?? null
      ).lastInsertRowid
  );
}

function coin(mem: Database.Database, name: string, source = "ai"): void {
  mem
    .prepare(
      "INSERT OR IGNORE INTO canonical_biomarkers (name, source) VALUES (?, ?)"
    )
    .run(name, source);
}

function categoryOf(mem: Database.Database, name: string): string | undefined {
  return (
    mem
      .prepare(
        "SELECT category FROM medical_records WHERE canonical_name = ? ORDER BY id LIMIT 1"
      )
      .get(name) as { category: string } | undefined
  )?.category;
}

function vocabulary(mem: Database.Database): string[] {
  return (
    mem
      .prepare("SELECT name FROM canonical_biomarkers ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function stars(mem: Database.Database, profileId = 1): string[] {
  return (
    mem
      .prepare(
        "SELECT key FROM saved_items WHERE profile_id = ? AND kind = 'biomarker' ORDER BY key"
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
}

function dismissals(mem: Database.Database, profileId = 1): string[] {
  return (
    mem
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

function gaps(mem: Database.Database, profileId = 1): string[] {
  return (
    mem
      .prepare(
        "SELECT item_key FROM coverage_gaps WHERE profile_id = ? ORDER BY item_key"
      )
      .all(profileId) as { item_key: string }[]
  ).map((r) => r.item_key);
}

// The database the issue found: four non-analyte shapes plus a questionnaire item,
// each with the full set of name-keyed side-state, beside three rows that must not
// move.
function seeded(): Database.Database {
  const mem = preMigrationDb();
  for (const name of NON_ANALYTES) {
    addRecord(mem, {
      name,
      // A "flagged" non-measurement — the extractor's guess on a row that is not in
      // or out of any band. The pass clears it along with the category.
      flag: name === STATUS ? "abnormal" : null,
      value: name === LOT ? "FAKE-01" : "Oral",
    });
    coin(mem, name);
    mem
      .prepare(
        "INSERT INTO saved_items (profile_id, kind, key) VALUES (1, 'biomarker', ?)"
      )
      .run(name);
    mem
      .prepare(
        "INSERT INTO coverage_gaps (profile_id, kind, item_key, label) VALUES (1, 'biomarker', ?, ?)"
      )
      .run(biomarkerCoverageKey(name), name);
    for (const key of [
      biomarkerDismissalKey(name),
      biomarkerFlagDismissalKey(name),
    ]) {
      mem
        .prepare(
          "INSERT OR IGNORE INTO upcoming_dismissals (profile_id, signal_key) VALUES (1, ?)"
        )
        .run(key);
    }
  }

  // A genuinely scored numeric observation from the SAME document.
  addRecord(mem, { name: SCORED, value: "7", valueNum: 7, unit: "{score}" });
  coin(mem, SCORED);
  // A CODED qualitative lab: textual, unitless, band-less — the same shape as a
  // qualifier, distinguished only by carrying an analyte code.
  addRecord(mem, { name: QUALITATIVE, value: "Negative", loinc: "5196-1" });
  coin(mem, QUALITATIVE, "seed");
  // A manually entered unitless row: no `ccda:obs:` key, so out of reach entirely.
  addRecord(mem, { name: MANUAL, value: "O+", externalId: null });
  coin(mem, MANUAL, "seed");
  return mem;
}

describe("migration 177 grows the category enum (#2318)", () => {
  it("refuses an `assessment` insert before, accepts one after", () => {
    const mem = preMigrationDb();
    const insert = () =>
      addRecord(mem, { name: "Anything", category: "assessment" });
    expect(insert).toThrow(/CHECK constraint failed/);

    up(mem);
    expect(insert).not.toThrow();
    expect(
      mem
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'medical_records'")
        .get()
    ).toMatchObject({ sql: expect.stringContaining("'report','assessment'") });
  });

  it("nulls a dangling nullable link before the FK'd copy", () => {
    const mem = seeded();
    const id = addRecord(mem, {
      name: SCORED,
      value: "8",
      valueNum: 8,
      externalId: "ccda:obs:mood screen score:2018-11-03:8",
    });
    mem
      .prepare("UPDATE medical_records SET document_id = 4242 WHERE id = ?")
      .run(id);

    up(mem);

    // 4242 is no medical_documents row, so the re-enabled FK would reject the copy;
    // the link degrades to NULL and the reading survives.
    expect(
      mem
        .prepare("SELECT document_id, value FROM medical_records WHERE id = ?")
        .get(id)
    ).toEqual({ document_id: null, value: "8" });
  });

  it("preserves ids and every column of the rows it copies", () => {
    const mem = seeded();
    const before = mem
      .prepare("SELECT id, name, value, loinc FROM medical_records ORDER BY id")
      .all();
    up(mem);
    expect(
      mem
        .prepare(
          "SELECT id, name, value, loinc FROM medical_records ORDER BY id"
        )
        .all()
    ).toEqual(before);
  });
});

describe("migration 177 re-homes the non-analyte observations", () => {
  it("moves every one of the four shapes out of `lab`", () => {
    const mem = seeded();
    for (const name of NON_ANALYTES) expect(categoryOf(mem, name)).toBe("lab");

    up(mem);

    for (const name of NON_ANALYTES) {
      expect(categoryOf(mem, name), name).toBe("assessment");
    }
    // The extractor's guessed flag goes with the category: a non-measurement is
    // neither in nor out of a band.
    expect(
      mem
        .prepare("SELECT flag FROM medical_records WHERE canonical_name = ?")
        .get(STATUS)
    ).toMatchObject({ flag: null });
  });

  it("leaves a scored reading, a coded qualitative lab and a manual row alone", () => {
    const mem = seeded();
    up(mem);
    for (const name of [SCORED, QUALITATIVE, MANUAL]) {
      expect(categoryOf(mem, name), name).toBe("lab");
    }
  });

  it("cleans up EVERY table that took a name from them", () => {
    const mem = seeded();
    up(mem);

    // 1. the ai-coined vocabulary rows are gone; the curated ones are untouchable.
    expect(vocabulary(mem)).toEqual([MANUAL, QUALITATIVE, SCORED].sort());
    // 2. the ★ pins
    expect(stars(mem)).toEqual([]);
    // 3. the retest snooze AND the flagged-result acknowledgment
    expect(dismissals(mem)).toEqual([]);
    // 4. the tracked coverage gap — otherwise a phantom forever
    expect(gaps(mem)).toEqual([]);
  });

  it("keeps a vocabulary row another profile still backs with a real reading", () => {
    const mem = seeded();
    // Profile B has a genuine lab under one of the coined names — the pass may take
    // the name away from A's assessment row, but not from the vocabulary.
    addRecord(mem, {
      profileId: 2,
      name: STATUS,
      value: "12",
      valueNum: 12,
      unit: "mg/dL",
    });

    up(mem);

    expect(categoryOf(mem, STATUS)).toBe("assessment"); // profile A's row moved
    expect(vocabulary(mem)).toContain(STATUS);
    // A's own side-state still goes: A has no identity-carrying row for that name.
    expect(stars(mem)).toEqual([]);
  });

  it("keeps a profile's own side-state when it still has a real reading of the name", () => {
    const mem = seeded();
    addRecord(mem, {
      name: SITE,
      value: "3.1",
      valueNum: 3.1,
      unit: "mg/dL",
      externalId: `ccda:obs:${SITE}:other`,
    });

    up(mem);

    expect(stars(mem)).toEqual([SITE]);
    expect(gaps(mem)).toEqual([biomarkerCoverageKey(SITE)]);
    expect(dismissals(mem)).toEqual(
      [biomarkerDismissalKey(SITE), biomarkerFlagDismissalKey(SITE)].sort()
    );
    expect(vocabulary(mem)).toContain(SITE);
  });
});

describe("migration 177 is replay-safe", () => {
  it("a second run changes nothing", () => {
    const mem = seeded();
    up(mem);
    const snapshot = mem
      .prepare("SELECT * FROM medical_records ORDER BY id")
      .all();
    const vocab = vocabulary(mem);

    up(mem);

    expect(
      mem.prepare("SELECT * FROM medical_records ORDER BY id").all()
    ).toEqual(snapshot);
    expect(vocabulary(mem)).toEqual(vocab);
  });

  it("runs on an empty database without touching anything", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(
      mem.prepare("SELECT COUNT(*) AS n FROM medical_records").get()
    ).toMatchObject({ n: 0 });
  });
});
