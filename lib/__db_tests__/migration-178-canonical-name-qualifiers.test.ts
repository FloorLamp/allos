// DB INTEGRATION TIER — migration 178 (#2335): the one-shot re-point onto the
// canonical spellings that state what they measure.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171/174 pattern),
// so every claim is about the migration and not about whatever else the baseline
// provides. The tables created here are exactly the ones a canonical rename touches,
// which is also the checked list of "everything keyed on a biomarker's canonical
// name" — the whole point of the test is that NOTHING on that list is orphaned.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/178-canonical-name-qualifiers";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "@/lib/dismissal-keys";
import { biomarkerCoverageKey } from "@/lib/coverage-gaps";
import { buildCanonicalIndex, snapCanonicalName } from "@/lib/canonical-name";

const DATE = "2018-11-02";

// Every rename the migration performs, restated here rather than imported: the test
// is what pins the pairs, so a later edit to the migration's frozen table has to be a
// deliberate one. Left column = the retired spelling a real database holds.
const RENAMES: [string, string][] = [
  ["Neutrophils", "Neutrophils, Relative"],
  ["Lymphocytes", "Lymphocytes, Relative"],
  ["Monocytes", "Monocytes, Absolute"],
  ["Eosinophils", "Eosinophils, Absolute"],
  ["Basophils", "Basophils, Absolute"],
  ["Immature Granulocytes", "Immature Granulocytes, Relative"],
  ["Nucleated Red Blood Cells", "Nucleated Red Blood Cells, Relative"],
  ["Reticulocytes", "Reticulocytes, Relative"],
  ["Intraocular Pressure", "Intraocular Pressure, Unspecified Eye"],
  ["Visual Acuity", "Visual Acuity, Unspecified Eye"],
  ["Free T4", "Thyroxine, Free (Free T4)"],
  ["Free T3", "Triiodothyronine, Free (Free T3)"],
  ["Total T4", "Thyroxine, Total (Total T4)"],
  ["Total T3", "Triiodothyronine, Total (Total T3)"],
  ["FEV1", "Forced Expiratory Volume in 1 Second (FEV1)"],
  ["FVC", "Forced Vital Capacity (FVC)"],
  ["eGFR", "Estimated Glomerular Filtration Rate (eGFR)"],
  ["RPR", "Rapid Plasma Reagin (RPR)"],
  [
    "HOMA-IR",
    "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
  ],
  [
    "ANA Screen, IFA",
    "Antinuclear Antibody Screen, Indirect Immunofluorescence Assay (ANA IFA)",
  ],
];

// One representative pair used for the side-state assertions. The differential's
// %-form is the sharpest case: it is the entry whose bare name used to mean the
// OPPOSITE of its neighbours'.
const [OLD, NEW] = RENAMES[0];
// A survivor: an entry this migration must not touch. Bare-means-serum is a universal
// convention, so "Albumin" beside "Albumin, Urine" is deliberately left alone.
const UNTOUCHED = "Albumin";

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

  const vocab = mem.prepare(
    "INSERT INTO canonical_biomarkers (name, source) VALUES (?, ?)"
  );
  const rec = mem.prepare(
    `INSERT INTO medical_records (profile_id, date, name, canonical_name, value)
     VALUES (?, ?, ?, ?, ?)`
  );
  // The vocabulary as the PREVIOUS release seeded it: every retired name present as a
  // curated `seed` row — which is why the seeder alone can never heal this (it has no
  // delete pass) and why the alias route added beside the rename would stay blocked.
  for (const [oldName] of RENAMES) {
    vocab.run(oldName, "seed");
    rec.run(1, DATE, oldName, oldName, "1");
  }
  vocab.run(UNTOUCHED, "seed");
  rec.run(1, DATE, UNTOUCHED, UNTOUCHED, "4.5");
  // An ai-coined analyte that this migration knows nothing about — it must survive.
  vocab.run("Fictional Unmapped Analyte", "ai");
  rec.run(
    1,
    DATE,
    "Fictional Unmapped Analyte",
    "Fictional Unmapped Analyte",
    "7"
  );
  // A second profile with its own copy of the drift — the rename is per profile.
  rec.run(2, DATE, OLD, OLD, "58");
  return mem;
}

function canonicalNames(mem: Database.Database, profileId: number): string[] {
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

describe("migration 178 — canonical names that state what they measure", () => {
  it("re-points every stored reading and retires every old vocabulary row", () => {
    const mem = preMigrationDb();
    up(mem);

    const after = canonicalNames(mem, 1);
    for (const [oldName, newName] of RENAMES) {
      expect(after, `${oldName} still stored`).not.toContain(oldName);
      expect(after, `${oldName} did not reach ${newName}`).toContain(newName);
    }
    // The reading's PRINTED name is provenance and is deliberately untouched.
    expect(
      mem
        .prepare(
          "SELECT name AS n FROM medical_records WHERE profile_id = 1 AND canonical_name = ?"
        )
        .get(NEW)
    ).toEqual({ n: OLD });

    const vocab = vocabulary(mem);
    for (const [oldName] of RENAMES)
      expect(vocab, `${oldName} still in the vocabulary`).not.toContain(
        oldName
      );
    // The surviving entries are inserted by seedCanonicalBiomarkers on the boot that
    // follows, so this migration leaves only what it did not retire.
    expect(vocab).toEqual([UNTOUCHED, "Fictional Unmapped Analyte"]);

    // Per profile, not globally.
    expect(canonicalNames(mem, 2)).toEqual([NEW]);
    mem.close();
  });

  it("leaves the bare-means-serum entries alone (the rule's one exception)", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(canonicalNames(mem, 1)).toContain(UNTOUCHED);
    expect(vocabulary(mem)).toContain(UNTOUCHED);
    mem.close();
  });

  it("carries every piece of name-keyed state, collapsing onto what the target had", () => {
    const mem = preMigrationDb();
    const star = mem.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    );
    star.run(1, OLD); // moves
    star.run(2, OLD); // collides with profile 2's existing target pin below
    star.run(2, NEW);
    const dismiss = mem.prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key) VALUES (?, ?)"
    );
    dismiss.run(1, biomarkerDismissalKey(OLD));
    dismiss.run(1, biomarkerFlagDismissalKey(OLD));
    mem
      .prepare(
        "INSERT INTO goals (profile_id, title, biomarker_name) VALUES (1, 'Fictional goal', ?)"
      )
      .run(OLD);
    mem
      .prepare(
        "INSERT INTO coverage_gaps (profile_id, kind, item_key, label) VALUES (1, 'biomarker', ?, ?)"
      )
      .run(biomarkerCoverageKey(OLD), OLD);
    mem
      .prepare(
        "INSERT INTO protocols (profile_id, name, outcome_keys) VALUES (1, 'Fictional protocol', ?)"
      )
      .run(JSON.stringify([`biomarker:${OLD}`, "index:phenoage"]));

    up(mem);

    expect(
      mem
        .prepare(
          "SELECT profile_id, key FROM saved_items ORDER BY profile_id, key"
        )
        .all()
    ).toEqual([
      { profile_id: 1, key: NEW },
      { profile_id: 2, key: NEW },
    ]);
    expect(
      mem
        .prepare(
          "SELECT signal_key AS k FROM upcoming_dismissals ORDER BY signal_key"
        )
        .all()
    ).toEqual(
      [biomarkerDismissalKey(NEW), biomarkerFlagDismissalKey(NEW)]
        .sort()
        .map((k) => ({ k }))
    );
    expect(mem.prepare("SELECT biomarker_name AS n FROM goals").get()).toEqual({
      n: NEW,
    });
    expect(
      mem.prepare("SELECT item_key, label FROM coverage_gaps").get()
    ).toEqual({ item_key: biomarkerCoverageKey(NEW), label: NEW });
    expect(
      mem.prepare("SELECT outcome_keys AS k FROM protocols").get()
    ).toEqual({
      k: JSON.stringify([`biomarker:${NEW}`, "index:phenoage"]),
    });
    mem.close();
  });

  it("orphans nothing: no row anywhere still names a retired spelling", () => {
    const mem = preMigrationDb();
    // One of every keyed shape, for EVERY rename — the miss this test exists to catch
    // is a pair the carry forgot, not a table it forgot.
    const star = mem.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (1, 'biomarker', ?)"
    );
    const dismiss = mem.prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key) VALUES (1, ?)"
    );
    const goal = mem.prepare(
      "INSERT INTO goals (profile_id, title, biomarker_name) VALUES (1, 'Fictional goal', ?)"
    );
    const gap = mem.prepare(
      "INSERT INTO coverage_gaps (profile_id, kind, item_key, label) VALUES (1, 'biomarker', ?, ?)"
    );
    const protocol = mem.prepare(
      "INSERT INTO protocols (profile_id, name, outcome_keys) VALUES (1, 'Fictional protocol', ?)"
    );
    for (const [oldName] of RENAMES) {
      star.run(oldName);
      dismiss.run(biomarkerDismissalKey(oldName));
      goal.run(oldName);
      gap.run(biomarkerCoverageKey(oldName), oldName);
      protocol.run(JSON.stringify([`biomarker:${oldName}`]));
    }

    up(mem);

    const retired = new Set(RENAMES.map(([o]) => o.toLowerCase()));
    const stillNamed: string[] = [];
    const check = (where: string, value: unknown) => {
      if (typeof value === "string" && retired.has(value.toLowerCase()))
        stillNamed.push(`${where}: ${value}`);
    };
    for (const r of mem
      .prepare("SELECT key FROM saved_items")
      .all() as { key: string }[])
      check("saved_items", r.key);
    for (const r of mem
      .prepare("SELECT biomarker_name AS n FROM goals")
      .all() as { n: string }[])
      check("goals", r.n);
    for (const r of mem
      .prepare("SELECT label FROM coverage_gaps")
      .all() as { label: string }[])
      check("coverage_gaps", r.label);
    for (const r of mem
      .prepare("SELECT canonical_name AS n FROM medical_records")
      .all() as { n: string }[])
      check("medical_records", r.n);
    for (const r of mem
      .prepare("SELECT outcome_keys AS k FROM protocols")
      .all() as { k: string }[])
      for (const key of JSON.parse(r.k) as string[])
        check("protocols", key.replace(/^biomarker:/, ""));
    // The DERIVED keys (retest snooze / flag acknowledgment) are keyed on the #482
    // identity, not the raw name, so they are checked through the same derivation.
    const retiredKeys = new Set(
      RENAMES.flatMap(([o]) => [
        biomarkerDismissalKey(o),
        biomarkerFlagDismissalKey(o),
      ])
    );
    const survivingKeys = new Set(
      RENAMES.flatMap(([, n]) => [
        biomarkerDismissalKey(n),
        biomarkerFlagDismissalKey(n),
      ])
    );
    for (const r of mem
      .prepare("SELECT signal_key AS k FROM upcoming_dismissals")
      .all() as { k: string }[])
      if (retiredKeys.has(r.k) && !survivingKeys.has(r.k))
        stillNamed.push(`upcoming_dismissals: ${r.k}`);

    expect(stillNamed).toEqual([]);
    mem.close();
  });

  it("is replay-safe: a second up() finds nothing to move and changes nothing", () => {
    const mem = preMigrationDb();
    up(mem);
    const vocabAfter = vocabulary(mem);
    const namesAfter = canonicalNames(mem, 1);

    up(mem);

    expect(vocabulary(mem)).toEqual(vocabAfter);
    expect(canonicalNames(mem, 1)).toEqual(namesAfter);
    mem.close();
  });

  it("leaves a database with no readings completely untouched", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE canonical_biomarkers (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        source TEXT NOT NULL DEFAULT 'ai'
      );
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        date TEXT NOT NULL, name TEXT, canonical_name TEXT, value TEXT
      );
      CREATE TABLE saved_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        kind TEXT NOT NULL, key TEXT NOT NULL COLLATE NOCASE,
        UNIQUE(profile_id, kind, key)
      );
      CREATE TABLE upcoming_dismissals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        signal_key TEXT NOT NULL
      );
      CREATE TABLE goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        title TEXT NOT NULL, biomarker_name TEXT
      );
      CREATE TABLE coverage_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        kind TEXT NOT NULL, item_key TEXT NOT NULL COLLATE NOCASE, label TEXT NOT NULL,
        UNIQUE(profile_id, kind, item_key)
      );
      CREATE TABLE protocols (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
        name TEXT NOT NULL, outcome_keys TEXT NOT NULL DEFAULT '[]'
      );
    `);
    mem.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Fresh')").run();
    up(mem);
    expect(vocabulary(mem)).toEqual([]);
    expect(canonicalNames(mem, 1)).toEqual([]);
    mem.close();
  });
});

describe("migration 178 — the surviving vocabulary answers for the old spellings", () => {
  it("routes every retired spelling onto its replacement in the CURRENT dataset", () => {
    // The migration moves what is on disk; CANONICAL_ALIASES is what keeps a document
    // that still PRINTS the old form landing correctly. Both halves are required, so
    // they are pinned together: for each pair, the shipped dataset must both carry the
    // new name and resolve the old one to it.
    const vocab = (
      canonicalSeed as { biomarkers: { name: string }[] }
    ).biomarkers.map((b) => b.name);
    const index = buildCanonicalIndex(vocab);
    const present = new Set(vocab.map((n) => n.toLowerCase()));
    for (const [oldName, newName] of RENAMES) {
      expect(present.has(newName.toLowerCase()), newName).toBe(true);
      expect(present.has(oldName.toLowerCase()), oldName).toBe(false);
      expect(snapCanonicalName(oldName, index), oldName).toBe(newName);
    }
  });
});
