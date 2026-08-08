// DB INTEGRATION TIER — migration 174 (#2306): the one-shot retirement of canonical
// biomarker spellings the dataset has superseded.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171 pattern), so
// every claim is about the migration and not about whatever else the baseline
// provides. The tables created here are exactly the ones the pass touches, which is
// also the checked list of "everything keyed on a biomarker's canonical name".
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/174-canonical-alias-merge";
import { biomarkerDismissalKey } from "@/lib/dismissal-keys";
import { biomarkerCoverageKey } from "@/lib/coverage-gaps";

const BLOCKED = "Occult Blood, Urine";
const BLOCKED_TARGET = "Blood, Urine";
const SHADOWED = "Hyaline Casts, Urine";
const SHADOWED_TARGET = "Casts, Hyaline, Urine";
const DATE = "2018-11-02";

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE canonical_biomarkers (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      source TEXT NOT NULL DEFAULT 'ai'
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      name TEXT,
      canonical_name TEXT,
      value TEXT
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
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      biomarker_name TEXT
    );
    CREATE TABLE coverage_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      item_key TEXT NOT NULL COLLATE NOCASE,
      label TEXT NOT NULL,
      UNIQUE(profile_id, kind, item_key)
    );
    CREATE TABLE protocols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      outcome_keys TEXT NOT NULL DEFAULT '[]'
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'A'), (2, 'B')")
    .run();
  // The curated targets, as seedCanonicalBiomarkers writes them …
  const vocab = mem.prepare(
    "INSERT INTO canonical_biomarkers (name, source) VALUES (?, ?)"
  );
  vocab.run(BLOCKED_TARGET, "seed");
  vocab.run(SHADOWED_TARGET, "seed");
  // … and the drifted spellings, as an import that predates the curated route left
  // them: ai-coined, claiming the very key the route needs.
  vocab.run(BLOCKED, "ai");
  vocab.run(SHADOWED, "ai");
  // An unrelated ai-coined analyte that supersedes nothing — it must survive.
  vocab.run("Fictional Unmapped Analyte", "ai");

  const rec = mem.prepare(
    `INSERT INTO medical_records (profile_id, date, name, canonical_name, value)
     VALUES (?, ?, ?, ?, ?)`
  );
  rec.run(1, DATE, BLOCKED, BLOCKED, "trace");
  rec.run(1, DATE, SHADOWED, SHADOWED, "0-2");
  rec.run(1, DATE, SHADOWED_TARGET, SHADOWED_TARGET, "1-3");
  rec.run(
    1,
    DATE,
    "Fictional Unmapped Analyte",
    "Fictional Unmapped Analyte",
    "7"
  );
  // A second profile with its own copy of the same drift — the rename is per profile.
  rec.run(2, DATE, BLOCKED, BLOCKED, "negative");
  return mem;
}

function names(mem: Database.Database, profileId: number): string[] {
  return (
    mem
      .prepare(
        `SELECT canonical_name AS n FROM medical_records
          WHERE profile_id = ? ORDER BY canonical_name, id`
      )
      .all(profileId) as { n: string }[]
  ).map((r) => r.n);
}

function vocabulary(mem: Database.Database): string[] {
  return (
    mem
      .prepare("SELECT name FROM canonical_biomarkers ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("migration 174 — superseded canonical names", () => {
  it("retires the blocking + shadowed ai rows and re-points every stored reading", () => {
    const mem = preMigrationDb();
    up(mem);

    expect(vocabulary(mem)).toEqual([
      BLOCKED_TARGET,
      SHADOWED_TARGET,
      "Fictional Unmapped Analyte",
    ]);
    expect(names(mem, 1)).toEqual([
      BLOCKED_TARGET,
      SHADOWED_TARGET,
      SHADOWED_TARGET,
      "Fictional Unmapped Analyte",
    ]);
    expect(names(mem, 2)).toEqual([BLOCKED_TARGET]);
    mem.close();
  });

  it("carries the name-keyed side-state, collapsing onto what the target already had", () => {
    const mem = preMigrationDb();
    const star = mem.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    );
    star.run(1, BLOCKED); // moves
    star.run(2, BLOCKED); // collides with profile 2's existing target pin below
    star.run(2, BLOCKED_TARGET);
    mem
      .prepare(
        "INSERT INTO upcoming_dismissals (profile_id, signal_key) VALUES (?, ?)"
      )
      .run(1, biomarkerDismissalKey(BLOCKED));
    mem
      .prepare(
        "INSERT INTO goals (profile_id, title, biomarker_name) VALUES (1, 'Fictional goal', ?)"
      )
      .run(BLOCKED);
    mem
      .prepare(
        "INSERT INTO coverage_gaps (profile_id, kind, item_key, label) VALUES (1, 'biomarker', ?, ?)"
      )
      .run(biomarkerCoverageKey(BLOCKED), BLOCKED);
    mem
      .prepare(
        "INSERT INTO protocols (profile_id, name, outcome_keys) VALUES (1, 'Fictional protocol', ?)"
      )
      .run(JSON.stringify([`biomarker:${BLOCKED}`, "index:phenoage"]));

    up(mem);

    expect(
      mem
        .prepare(
          "SELECT profile_id, key FROM saved_items ORDER BY profile_id, key"
        )
        .all()
    ).toEqual([
      { profile_id: 1, key: BLOCKED_TARGET },
      { profile_id: 2, key: BLOCKED_TARGET },
    ]);
    expect(
      mem.prepare("SELECT signal_key AS k FROM upcoming_dismissals").get()
    ).toEqual({ k: biomarkerDismissalKey(BLOCKED_TARGET) });
    expect(mem.prepare("SELECT biomarker_name AS n FROM goals").get()).toEqual({
      n: BLOCKED_TARGET,
    });
    expect(
      mem.prepare("SELECT item_key, label FROM coverage_gaps").get()
    ).toEqual({
      item_key: biomarkerCoverageKey(BLOCKED_TARGET),
      label: BLOCKED_TARGET,
    });
    expect(
      mem.prepare("SELECT outcome_keys AS k FROM protocols").get()
    ).toEqual({
      k: JSON.stringify([`biomarker:${BLOCKED_TARGET}`, "index:phenoage"]),
    });
    mem.close();
  });

  it("clears the canonical-flags signature so the boot reconcile re-derives once", () => {
    const mem = preMigrationDb();
    mem
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-sentinel')"
      )
      .run();
    up(mem);
    expect(
      mem
        .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
        .get()
    ).toBeUndefined();
    mem.close();
  });

  it("is replay-safe: a second up() finds nothing superseded and changes nothing", () => {
    const mem = preMigrationDb();
    mem
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-sentinel')"
      )
      .run();
    up(mem);
    const vocabAfter = vocabulary(mem);
    const namesAfter = names(mem, 1);
    mem
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'reconciled')"
      )
      .run();

    up(mem);

    expect(vocabulary(mem)).toEqual(vocabAfter);
    expect(names(mem, 1)).toEqual(namesAfter);
    // The replay found no drift, so it did NOT re-arm the flag reconcile.
    expect(
      mem
        .prepare(
          "SELECT value AS v FROM settings WHERE key = 'canonical_flags_sig'"
        )
        .get()
    ).toEqual({ v: "reconciled" });
    mem.close();
  });

  it("leaves a database with no drift completely untouched", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE canonical_biomarkers (name TEXT PRIMARY KEY COLLATE NOCASE, source TEXT NOT NULL DEFAULT 'ai');
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        date TEXT NOT NULL, name TEXT, canonical_name TEXT, value TEXT);
    `);
    mem.prepare("INSERT INTO profiles (name) VALUES ('A')").run();
    mem
      .prepare(
        "INSERT INTO canonical_biomarkers (name, source) VALUES (?, 'seed')"
      )
      .run(BLOCKED_TARGET);
    mem
      .prepare(
        `INSERT INTO medical_records (profile_id, date, name, canonical_name, value)
         VALUES (1, ?, ?, ?, 'negative')`
      )
      .run(DATE, BLOCKED_TARGET, BLOCKED_TARGET);

    // Nothing to do → no write transaction is opened at all, so the tables the pass
    // would otherwise touch (saved_items, goals, coverage_gaps, protocols …) need not
    // even exist. That is the property that keeps this cheap on every notify-tick boot.
    expect(() => up(mem)).not.toThrow();
    expect(vocabulary(mem)).toEqual([BLOCKED_TARGET]);
    mem.close();
  });
});
