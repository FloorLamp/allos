import { describe, expect, it } from "vitest";
import {
  norm,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "./sql-scan";

// ONE PRODUCTION `INSERT INTO intake_items` (#4669).
//
// Three statements used to mint an intake item, with three different column sets, and
// the difference between them was unreadable: a column absent from one was sometimes a
// deliberate difference (an import knows no brand) and sometimes a defect (an imported
// prescription landed `rx = 0` — OTC — despite carrying a prescriber and an Rx number).
// One statement makes that distinction structural: what a caller does not pass, it does
// not know, and the core decides the rest.
//
// The same proof style as the gated-table write scan (stateful-writes.test.ts) and the
// media-input scan: read the repo's own source as TEXT through the shared scanner — no
// DB, no network — and state membership rather than freeze a count.
//
// THE THREE THINGS THIS SCAN DOES TO ITSELF, because four censuses in this repo have
// shipped blind to part of their population:
//   1. a POSITIVE CONTROL — the owner's own statement must be found, and found with the
//      full column set. A scan whose extractor stops matching goes green by being blind.
//   2. a FLOOR on its own population — the file walk and the statement extractor each
//      have to reach a number that proves they ran.
//   3. it THROWS on an `INSERT INTO intake_items` it cannot parse, rather than skipping
//      it. An unparseable statement is the one most likely to be the new offender.

/** The one legitimate home of an intake-item create. */
const OWNER = "lib/intake-item-create.ts";

/**
 * Columns the owner's statement must still name. Not the whole list — that would be a
 * frozen count in disguise — but every column whose ABSENCE from one of the three old
 * statements was the defect or the deliberate difference #4669 had to tell apart.
 */
const OWNER_COLUMNS = [
  "profile_id",
  "kind",
  "obligation",
  "rx",
  "source",
  "document_id",
  "import_key",
  "quantity_on_hand",
  "supply_id",
  "redose_notice",
  "cadence_kind",
  "created_at",
];

/**
 * Shipped migrations that insert an intake item. A migration is a one-shot data move
 * that ran before this core existed and is frozen by the immutable hash manifest — it
 * is never edited, so it is a declared NON-MEMBER rather than a violation.
 *
 * `statements` is exact in BOTH directions: too few is as much a failure as too many,
 * because a stale entry is a claim about a file that no longer matches it.
 */
const NOT_A_CREATE_PATH = new Map<string, { statements: number; why: string }>([
  [
    "lib/migrations/versions/092-consolidate-imported-prescriptions.ts",
    {
      statements: 1,
      why: "the #1178 one-shot consolidation: projects each unpaired legacy prescription record into an extracted medication, once, at upgrade time",
    },
  ],
  [
    "lib/migrations/versions/101-recover-blank-name-prescriptions.ts",
    {
      statements: 1,
      why: "the #1281 corrective to 092: re-projects each surviving blank-name prescription under a placeholder name, once, at upgrade time",
    },
  ],
]);

/**
 * The DB and action TEST TIERS, out of scope on the same terms the gated-table write
 * scan states: their `INSERT INTO intake_items` fixtures seed a starting world for a
 * test to act on — they are not a runtime write path a tap can reach, and forcing them
 * through the core would make a fixture unable to set up the very states the core is
 * tested against. `lib/__tests__/**` is already dropped by the shared file walk.
 */
const TEST_TIERS = ["lib/__db_tests__/", "lib/__action_tests__/"];

const INTO_ITEMS = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+intake_items\b/i;

/**
 * The column list of an `INSERT INTO intake_items`, or a THROW.
 *
 * Returning null for "cannot parse" is what makes a census lie: the statement it cannot
 * read is exactly the one most likely to be the new spelling nobody registered. A
 * table-rebuild `intake_items__new` is not this table and is excluded by the word
 * boundary above, so anything that reaches here and does not parse is a real unknown.
 */
function itemInsertColumns(sql: string): string[] {
  const m = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+intake_items\s*\(([^)]*)\)/i.exec(
    sql
  );
  if (!m) {
    throw new Error(
      `Unparseable INSERT INTO intake_items — the scan refuses to skip what it cannot read. SQL: ${sql}`
    );
  }
  return m[1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

interface Found {
  rel: string;
  columns: string[];
}

const HOW = [
  "A second way to create an intake item. Every door — the item form, an accepted",
  "AI suggestion, an imported prescription — mints its row through",
  `createIntakeItemCore (${OWNER}), which owns the column set, the kind's`,
  "defaults, the Rx/OTC derivation, the dose rows and a new medication's opening",
  "course. Pass it the fields you know instead of spelling the INSERT again.",
].join("\n");

describe("one production INSERT INTO intake_items (#4669)", () => {
  const files = sourceFiles();
  let statements = 0;
  const found: Found[] = [];
  for (const file of files) {
    const rel = relPath(file);
    if (TEST_TIERS.some((prefix) => rel.startsWith(prefix))) continue;
    const src = readSource(file);
    if (!src.includes("intake_items")) continue;
    for (const arg of prepareArgs(src)) {
      if (arg.kind !== "sql") continue;
      statements++;
      const sql = norm(arg.text);
      if (!INTO_ITEMS.test(sql)) continue;
      found.push({ rel, columns: itemInsertColumns(sql) });
    }
  }
  const byFile = new Map<string, Found[]>();
  for (const f of found) byFile.set(f.rel, [...(byFile.get(f.rel) ?? []), f]);

  it("the scan reached its population — the walk and the extractor both ran", () => {
    // The floor, not a frozen count: a broken glob or a broken quote-reader would
    // otherwise make every assertion below pass by finding nothing to judge.
    expect(files.length).toBeGreaterThan(30);
    expect(statements).toBeGreaterThan(20);
    expect(found.length).toBeGreaterThan(0);
  });

  it("the owner still spells the create, with the columns the three doors disagreed about", () => {
    // THE POSITIVE CONTROL. If the owner's own statement stops matching — a rename, a
    // switch to a computed column list, a move — the membership assertion below is
    // green because the scan is blind, not because the tree is clean.
    const mine = byFile.get(OWNER) ?? [];
    expect(mine).toHaveLength(1);
    for (const column of OWNER_COLUMNS) {
      expect(mine[0].columns, `owner must still bind ${column}`).toContain(
        column
      );
    }
  });

  it("no other production module creates an intake item", () => {
    const offenders = [...byFile.keys()].filter(
      (rel) => rel !== OWNER && !NOT_A_CREATE_PATH.has(rel)
    );
    expect(offenders, `${HOW}\n\n${offenders.join("\n")}`).toEqual([]);
  });

  it.each([...NOT_A_CREATE_PATH])(
    "%s is still the shape its entry describes",
    (rel, entry) => {
      // Both directions: a declared non-member that stopped matching is a stale claim,
      // and a stale claim is an exemption nobody is checking.
      expect(byFile.get(rel) ?? [], entry.why).toHaveLength(entry.statements);
    }
  );

  it("REFUSES an intake-item INSERT it cannot parse, rather than passing over it", () => {
    // The guard's own guard. A census that quietly skips the statement it cannot read
    // is the failure mode this repo keeps naming; this proves the skip does not exist.
    expect(() =>
      itemInsertColumns("INSERT INTO intake_items SELECT * FROM somewhere_else")
    ).toThrow(/refuses to skip/);
    // …and that it still reads an ordinary one.
    expect(
      itemInsertColumns(
        "INSERT INTO intake_items (profile_id, name) VALUES (?,?)"
      )
    ).toEqual(["profile_id", "name"]);
  });
});
