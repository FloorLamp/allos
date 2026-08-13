// DB INTEGRATION TIER — issue #2677: a CHILD_LINKS entry must be EXERCISED, not just
// spelled correctly.
//
// THE DEFECT CLASS, one level down from #2444. That defect was a registry whose entries
// named columns that have never existed — it READ like a guard and covered nothing. The
// corrective test (migration-child-links.test.ts, this file's twin) closed the half
// where a pair is a typo: every declared (table, column) is checked against the FINAL
// migrated schema. What it never asked is whether a declared, REAL pair does anything.
//
// It did not. `20260813-bmi-derived-rows` declares three pairs, all three correct, and
// only ONE had a fixture: deleting either of the other two from the array left the
// whole DB tier green — 686 files, 5688 tests. Migration 180 is worse. Its fixture
// creates no child table at all, so `hasColumn` filtered every link out and all four
// entries were unexercised, including `intake_items.source_record_id`, the one entry it
// got right and the only thing that would have protected a real database's rows.
//
// WHAT THIS FILE ASSERTS, per migration that declares link literals:
//
//   1. NOTHING REAL IS MISSING. The non-cascading FK parents of the table the migration
//      deletes from are read out of the migrated schema; every one must be declared, or
//      frozen below with a reason. This check is derived from the SCHEMA, which is what
//      makes deleting an entry from the array fail: the declaration cannot switch off
//      the thing that judges it.
//   2. EVERY DECLARED, REAL PAIR BLOCKS. One test per pair — plant a child row pointing
//      at the candidate row through that pair, run the migration, require the row to
//      SURVIVE. A pair the migration never consults fails on its own row, by name.
//   3. THE FIXTURE CAN TELL THE DIFFERENCE. Two controls, because "the row survived"
//      proves nothing on its own: with no child row the same row must be DELETED, and
//      in each protected case a second, unreferenced candidate must still go — so
//      neither a migration that deletes nothing nor one that bails out entirely on the
//      first reference can pass.
//   4. THE FROZEN GAPS ARE STILL GAPS. Migration 180's two undeclared real parents are
//      reaped the way the twin reaps its misnamed entries: each must still fail to
//      block, and the list may only shrink.
//
// The fixture's child tables are DERIVED from the schema too (`childTablesDdl`), so a
// new non-cascading parent of `medical_records` arrives in every fixture at once and
// cannot be quietly left out of one.
//
// A new migration declaring CHILD_LINKS registers a fixture in CHILD_LINK_FIXTURES
// below; the census fails one that does not.
//
// KNOWN BOUNDARIES, stated so their silence does not read as coverage:
//
//   A pair that names a real column which is NOT a parent of the deleted table is not
//   flagged as surplus. It cannot hide anything: the twin proves the column exists, and
//   the parent such an entry was MEANT to be then shows up as missing in check 1 — which
//   is exactly how migration 180's `care_plan_items.source_record_id` reads.
//
//   Only NON-CASCADING parents are here. The cascading children a migration must clear
//   itself are the opposite obligation and #2680's; they live in the twin.
//
//   A migration whose delete is conditional in ways a synthetic fixture cannot reach is
//   still only proven for the shapes its fixture builds. The fixture is the per-migration
//   part; everything around it is derived.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { up as up180 } from "@/lib/migrations/versions/180-waist-circumference-metric";
import { up as upBmi } from "@/lib/migrations/versions/20260813-bmi-derived-rows";
import { linkKey, linkLiterals } from "./migration-link-scan";

interface LinkPair {
  table: string;
  column: string;
}

/**
 * The pairs whose reference must BLOCK a delete of `parent`, read out of the migrated
 * schema — the same rule the twin file's pin uses (anything not CASCADE, so SET NULL
 * counts too: SQLite will not run it while the runner holds `foreign_keys = OFF`).
 *
 * FAILS CLOSED on a composite inbound key: a `{ table, column }` pair cannot express
 * one, so a migration's registry could not guard it and a silent skip here would be
 * this family's own defect. There is none today.
 */
function nonCascadingParents(parent: string): LinkPair[] {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: LinkPair[] = [];
  for (const table of tables) {
    for (const fk of db
      .prepare(`PRAGMA foreign_key_list("${table}")`)
      .all() as {
      seq: number;
      table: string;
      from: string;
      on_delete: string;
    }[]) {
      if (fk.table !== parent) continue;
      if (fk.on_delete === "CASCADE") continue;
      if (fk.seq !== 0)
        throw new Error(
          `${table} references ${parent} through a COMPOSITE key; a CHILD_LINKS ` +
            `(table, column) pair cannot express it`
        );
      out.push({ table, column: fk.from });
    }
  }
  return out.sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
}

/**
 * A minimal child table per real non-cascading parent of `parent`, so a fixture cannot
 * omit one and so a NEW parent lands in every fixture without an edit. Only the columns
 * this census needs: a key, the profile scope, and each referencing column.
 */
function childTablesDdl(parent: string): string {
  const byTable = new Map<string, string[]>();
  for (const pair of nonCascadingParents(parent))
    byTable.set(pair.table, [...(byTable.get(pair.table) ?? []), pair.column]);
  return [...byTable]
    .map(
      ([table, columns]) =>
        `CREATE TABLE ${table} (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           profile_id INTEGER NOT NULL,
           ${columns.map((c) => `${c} INTEGER`).join(",\n           ")}
         );`
    )
    .join("\n");
}

/**
 * A child row referencing `parentId` through `pair`. Generic over the fixture's shape:
 * every NOT NULL column without a default is filled, so a fixture table that grows a
 * required column does not need this helper edited.
 */
function planChildRow(
  mem: Database.Database,
  pair: LinkPair,
  parentId: number,
  profileId: number
): void {
  const columns = mem.prepare(`PRAGMA table_info(${pair.table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  expect(
    columns.map((c) => c.name),
    `the fixture's ${pair.table} has no ${pair.column} column, so the migration's ` +
      `own hasColumn() probe would skip this link and the test would prove nothing`
  ).toContain(pair.column);
  const names: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    if (column.name === pair.column) {
      names.push(column.name);
      values.push(parentId);
      continue;
    }
    if (column.pk === 1) continue;
    if (column.notnull === 0 || column.dflt_value !== null) continue;
    names.push(column.name);
    values.push(
      column.name === "profile_id"
        ? profileId
        : /INT|REAL|NUM|DOUB|FLOA/i.test(column.type)
          ? 0
          : "x"
    );
  }
  mem
    .prepare(
      `INSERT INTO ${pair.table} (${names.join(", ")})
       VALUES (${names.map(() => "?").join(", ")})`
    )
    .run(...values);
}

interface ChildLinkFixture {
  /** the migration file, as `linkLiterals()` names it */
  file: string;
  /** the table this migration deletes rows from — CHILD_LINKS names ITS parents */
  parent: string;
  up: (mem: Database.Database) => void;
  /** a database in which BOTH candidate rows below are rows `up` deletes */
  make: (childTables: string) => Database.Database;
  profileId: number;
  /** the row a planted child reference must save */
  protectedId: number;
  /** a second candidate, never referenced, which must go every time */
  alsoDeletedId: number;
  /**
   * Real parents of `parent` this HASH-LOCKED file does not declare. Each is a #2444
   * gap that cannot be corrected in place; the list may only SHRINK, and only by a
   * migration file leaving the repo.
   */
  frozenUndeclared: readonly { table: string; column: string; why: string }[];
}

const WAIST_DATE = "2016-03-04";
const BMI_DATE = "2016-05-09";

// The minimal pre-migration shape both migrations were written against (the
// 165/171/174/176/180 pattern), plus the child tables derived above.
function bmiFixture(childTables: string): Database.Database {
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
      value_num REAL
    );
    ${childTables}
    CREATE TABLE canonical_biomarkers (name TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE saved_items (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL
    );
    CREATE TABLE coverage_gaps (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL
    );
    CREATE TABLE upcoming_dismissals (
      profile_id INTEGER NOT NULL, signal_key TEXT NOT NULL
    );
    INSERT INTO profiles (id, name) VALUES (1, 'A');
    INSERT INTO medical_records
      (id, profile_id, date, category, name, canonical_name, value, value_num)
    VALUES
      (31, 1, '${BMI_DATE}', 'vitals', 'BMI', 'Body Mass Index (BMI)', '24.2', 24.2),
      (32, 1, '2016-05-16', 'vitals', 'BMI', 'Body Mass Index (BMI)', '24.3', 24.3);
  `);
  return mem;
}

function waistFixture(childTables: string): Database.Database {
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
    ${childTables}
    CREATE TABLE canonical_biomarkers (name TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE saved_items (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL
    );
    CREATE TABLE coverage_gaps (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL
    );
    CREATE TABLE upcoming_dismissals (
      profile_id INTEGER NOT NULL, signal_key TEXT NOT NULL
    );
    INSERT INTO profiles (id, name) VALUES (1, 'A');
    INSERT INTO medical_records
      (id, profile_id, date, category, name, canonical_name, value, value_num,
       unit, loinc, source)
    VALUES
      (41, 1, '${WAIST_DATE}', 'vitals', 'Waist Circumference', NULL, '84', 84,
       'cm', NULL, 'manual'),
      (42, 1, '2016-03-18', 'vitals', 'Waist Circumference', NULL, '85', 85,
       'cm', NULL, 'manual');
  `);
  return mem;
}

const CHILD_LINK_FIXTURES: readonly ChildLinkFixture[] = [
  {
    file: "180-waist-circumference-metric.ts",
    parent: "medical_records",
    up: up180,
    make: waistFixture,
    profileId: 1,
    protectedId: 41,
    alsoDeletedId: 42,
    frozenUndeclared: [
      {
        table: "care_plan_items",
        column: "source_medical_record_id",
        why: "#2444: 180 declared `care_plan_items.source_record_id`, a column that has never existed, so this real parent went unguarded and the migration deleted a live follow-up's source reading. The file is hash-locked; migration 184 nulls what it orphaned.",
      },
      {
        table: "care_plan_items",
        column: "resolved_by_medical_record_id",
        why: "#2444: never named by 180 in any spelling — the same unguarded delete as the entry above, for the reading that CLOSED a follow-up. Repaired by migration 184.",
      },
    ],
  },
  {
    file: "20260813-bmi-derived-rows.ts",
    parent: "medical_records",
    up: upBmi,
    make: bmiFixture,
    profileId: 1,
    protectedId: 31,
    alsoDeletedId: 32,
    frozenUndeclared: [],
  },
];

function recordIds(mem: Database.Database, profileId: number): number[] {
  return (
    mem
      .prepare(
        "SELECT id FROM medical_records WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as { id: number }[]
  ).map((r) => r.id);
}

describe("every migration declaring child links registers a fixture (#2677)", () => {
  it("the scan finds link literals at all (the census is not vacuous)", () => {
    expect(linkLiterals().length).toBeGreaterThan(0);
    expect(CHILD_LINK_FIXTURES.length).toBeGreaterThan(0);
  });

  it("covers every file that declares one", () => {
    const declaring = [...new Set(linkLiterals().map((l) => l.file))].sort();
    expect(
      declaring,
      "a migration declaring CHILD_LINKS must register a fixture in " +
        "CHILD_LINK_FIXTURES so each of its pairs is exercised (#2677). Declaring a " +
        "pair and never planting a row against it is the #2444 defect one level up: " +
        "the registry reads like a guard and nothing proves it guards."
    ).toEqual(CHILD_LINK_FIXTURES.map((f) => f.file).sort());
  });
});

for (const fixture of CHILD_LINK_FIXTURES) {
  // Read at collection time: the schema is the migrated template's, identical for
  // every file in the tier, and this decides which per-pair tests exist.
  const real = nonCascadingParents(fixture.parent);
  const declared = new Set(
    linkLiterals()
      .filter((l) => l.file === fixture.file)
      .map(linkKey)
  );
  const frozen = new Set(fixture.frozenUndeclared.map(linkKey));
  const exercised = real.filter((pair) => declared.has(linkKey(pair)));

  describe(`${fixture.file} — its child links actually block (#2677)`, () => {
    it(`declares every non-cascading FK parent of ${fixture.parent}`, () => {
      const missing = real
        .map(linkKey)
        .filter((key) => !declared.has(key) && !frozen.has(key));
      expect(
        missing,
        `a row referenced through one of these is deleted anyway (#2444). The set is ` +
          `read from the migrated schema, not from the declaration, so removing an ` +
          `entry from CHILD_LINKS fails HERE rather than quietly removing its own test.`
      ).toEqual([]);
    });

    it("the fixture is capable: an unreferenced candidate row is deleted", () => {
      const mem = fixture.make(childTablesDdl(fixture.parent));
      expect(recordIds(mem, fixture.profileId)).toEqual([
        fixture.protectedId,
        fixture.alsoDeletedId,
      ]);
      fixture.up(mem);
      expect(
        recordIds(mem, fixture.profileId),
        "both candidates must go when nothing points at them — otherwise 'the row " +
          "survived' below is not evidence about the child link"
      ).toEqual([]);
    });

    for (const pair of exercised) {
      it(`blocks on ${linkKey(pair)}`, () => {
        const mem = fixture.make(childTablesDdl(fixture.parent));
        planChildRow(mem, pair, fixture.protectedId, fixture.profileId);
        fixture.up(mem);
        expect(
          recordIds(mem, fixture.profileId),
          `${linkKey(pair)} is declared in ${fixture.file} but the row it points at ` +
            `was deleted anyway — the entry is inert. The second id must still be ` +
            `gone: the guard is per ROW, not a bail-out on the first reference.`
        ).toEqual([fixture.protectedId]);
      });
    }

    for (const gap of fixture.frozenUndeclared) {
      it(`reaps the frozen gap at ${linkKey(gap)} (it must still NOT block)`, () => {
        expect(
          real.map(linkKey),
          `${linkKey(gap)} is no longer a non-cascading parent of ${fixture.parent} ` +
            `— the frozen entry is stale, drop it`
        ).toContain(linkKey(gap));
        expect(
          declared.has(linkKey(gap)),
          `${fixture.file} now declares ${linkKey(gap)} — drop the frozen entry and ` +
            `let the pair be exercised`
        ).toBe(false);
        expect(gap.why.length).toBeGreaterThan(30);
        const mem = fixture.make(childTablesDdl(fixture.parent));
        planChildRow(mem, gap, fixture.protectedId, fixture.profileId);
        fixture.up(mem);
        expect(
          recordIds(mem, fixture.profileId),
          "the undeclared parent does not protect the row it references — this is " +
            "the #2444 damage, pinned so a claimed fix has to prove itself"
        ).toEqual([]);
      });
    }
  });
}
