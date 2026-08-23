import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A historical-shape fixture must name the migration it stops before (#3565).
//
// A test that rebuilds a database "as of just before migration X" has to decide
// where to stop. Deciding by POSITION — `MIGRATIONS.slice(0, -1)`, "every
// migration but the newest" — is correct on exactly the one day X is newest.
// The next migration to merge pushes X into the prefix, so the "before" database
// silently receives the future and the test starts exercising whichever
// migration landed last, under a filename that still says X.
//
// It stays GREEN through that transition. That is the whole defect: nothing goes
// red, so nobody finds out. `migration-20260814-remove-legacy-schema-shells`
// spent weeks measuring somebody else's migration this way.
//
// `migrationsBefore(name)` in lib/migrations/versions/index.ts is the remedy for
// the name-keyed era, as `NUMBERED_MIGRATIONS` is for the closed numbered one.
// It throws on an unknown name, so a rename fails loudly instead of widening the
// slice to everything.
//
// AND THIS FILE HAS TO SURVIVE ITS OWN LESSON. A census whose verdict is an
// ABSENCE — "no fixture slices by position" — is green over a corpus it never
// walked, which is the same failure it exists to catch, one level up. The first
// version of this file was exactly that: pointing the roots at a directory that
// does not exist left `offenders` empty and all four tests passed (#3569
// review). So the walk is now asserted BEFORE any verdict (a file floor, and
// every root non-empty), a missing root THROWS rather than contributing zero
// files, and one synthetic offender is PLANTED on disk for the walk to go and
// find. #3206 is this repo's receipt for absence assertions over a shrinking
// corpus.
//
// What this scan does NOT flag, deliberately — a guard that cried wolf on these
// would be deleted within a week, taking the real guard with it:
//   * `MIGRATIONS[0]`, `MIGRATIONS[14]`, `MIGRATIONS[V162 - 1]` — reaching for
//     ONE migration's `up()` in the CLOSED numbered era, where id === position+1
//     is frozen and asserted. Those indexes cannot drift.
//   * `NUMBERED_MIGRATIONS.filter((m) => m.id < N)` — the numbered era's own
//     remedy, already name-safe because ids are frozen.
//   * `MIGRATIONS.find((m) => m.id === 41)` — identity by id, not by position.

const REPO = path.join(__dirname, "..", "..");

// The three test tiers, plus the two other places that could import the
// registry. Nothing under `e2e/` or `scripts/` slices MIGRATIONS today, and
// keeping that true is what a corpus scan is for — a true-today claim costs one
// entry here and stops being an assumption (#3569 review, Q5).
const ROOTS = [
  "lib/__tests__",
  "lib/__db_tests__",
  "lib/__action_tests__",
  "e2e",
  "scripts",
];

/**
 * ONE CORPUS THIS CENSUS CAN BE POINTED AT: a base directory, and the roots to
 * walk beneath it. In production there is exactly one — the tree.
 *
 * The parameter exists for the planted-offender case at the bottom of this file.
 * That case must find its offender BY WALKING, and planting into the live,
 * git-tracked tree races the other guards that walk these same directories
 * concurrently: they collect a file list and read it a moment later, and an
 * `afterAll` unlink lands in that window as an ENOENT in a test that has nothing
 * to do with migrations (#3557 review). So the discipline is unchanged and the
 * LOCATION moved: the same `sourceFiles` and the same `census` are pointed at a
 * `mkdtemp` corpus only that test can see.
 */
type Corpus = { base: string; roots: string[] };

/** The tree itself — what every verdict below is made against. */
const TREE: Corpus = { base: REPO, roots: ROOTS };

// THE FLOOR THE WALK MUST CLEAR, measured 2026-08-23: 999 + 581 + 197 + 526 + 72
// = 2375 source files across the five roots. Not the exact count — files arrive
// with every feature — but a number well above zero, so a walk that has stopped
// walking fails LOUDLY instead of reporting a clean sweep it never took.
const CORPUS_FLOOR = 2000;
// And every root separately, because the roots are the point: a walk that enters
// four of five is a blind spot the total would absorb. The smallest root today
// is `scripts` at 72.
const PER_ROOT_FLOOR = 25;

// This file holds the forbidden spellings as data; scanning itself would be a
// self-match, not a finding.
const SELF = "lib/__tests__/migration-historical-fixture-scan.test.ts";

const ALLOWED: Record<string, string> = {
  // The runner's positional invariants ARE this file's subject: the numbered era
  // is a frozen contiguous prefix, and the backfill cases apply the first K by
  // hand. It slices to a count, never to stand in for a named migration.
  "lib/__db_tests__/runner.test.ts":
    "asserts the registry's positional invariants themselves",
  // "one migration behind the build" is genuinely relative to the build's count
  // — the point is that a pending set exists, not which migration it is.
  "lib/__db_tests__/migration-snapshot.test.ts":
    "needs a database one behind the build, not one before a named migration",
};

// `(?<!\w)` keeps NUMBERED_MIGRATIONS.slice(...) out — it is the sanctioned
// remedy for the numbered era, not the defect.
const POSITIONAL = /(?<!\w)MIGRATIONS\.(?:slice|findIndex)\(/;

/** Anything that can import the registry: ts/tsx/js/jsx and the m/c variants. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Source with comments removed — prose about the pattern must not register. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function slicesByPosition(source: string): boolean {
  return POSITIONAL.test(codeOnly(source));
}

/**
 * Every source file under one root, relative to the corpus base.
 *
 * A MISSING ROOT THROWS. Returning an empty list for a directory that is not
 * there is how the first version of this file reported a clean sweep over
 * nothing at all: a rename upstream, or a typo here, and the census silently
 * measures zero files and passes.
 */
function sourceFiles(root: string, base: string = REPO): string[] {
  if (!fs.existsSync(path.join(base, root))) {
    throw new Error(
      `Scan root "${root}" does not exist under ${base}. A root that is not ` +
        `walked contributes no files and no findings — fix the root rather ` +
        `than letting the census report a sweep it never took.`
    );
  }
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(base, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(child);
      } else if (SOURCE.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk(root);
  return out.sort();
}

type Scan = { files: string[]; offenders: string[] };

function census(corpus: Corpus = TREE): Scan {
  const files: string[] = [];
  const offenders: string[] = [];
  for (const root of corpus.roots) {
    for (const rel of sourceFiles(root, corpus.base)) {
      files.push(rel);
      if (rel === SELF || rel in ALLOWED) continue;
      if (
        slicesByPosition(fs.readFileSync(path.join(corpus.base, rel), "utf8"))
      )
        offenders.push(rel);
    }
  }
  return { files, offenders };
}

// The tree's own sweep, taken once and shared by the describes below.
const swept = census();

describe("historical-shape fixtures slice by name, not by array position", () => {
  // THE WALK ITSELF, ASSERTED BEFORE ANYTHING IS JUDGED.
  it("walks the corpus it is about to judge", () => {
    expect(
      swept.files.length,
      `Walked ${swept.files.length} files under ${ROOTS.join(", ")}, below the ` +
        `floor of ${CORPUS_FLOOR}. Either this scan has stopped seeing them (a ` +
        `renamed root, an extension it no longer matches, a walk that stopped ` +
        `recursing) or the files really are gone — check which before lowering ` +
        `this number.`
    ).toBeGreaterThanOrEqual(CORPUS_FLOOR);
    for (const root of ROOTS) {
      expect(
        swept.files.filter((f) => f.startsWith(`${root}/`)).length,
        `Root "${root}" contributed almost nothing to the sweep. A root the ` +
          `walk does not really enter is a blind spot the total absorbs.`
      ).toBeGreaterThanOrEqual(PER_ROOT_FLOOR);
    }
  });

  it("no test tier builds a 'before' database by position", () => {
    expect(
      swept.offenders,
      "These files slice MIGRATIONS by position to build a historical " +
        "database. Position is not identity: the slice means what its author " +
        "intended on exactly one day, then silently rebuilds the future into " +
        "the 'before' database and keeps passing. Use " +
        '`migrationsBefore("<migration name>")` from ' +
        `@/lib/migrations/versions instead:\n${swept.offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlist entry still slices by position", () => {
    // A stale allowlist is a scan that has quietly stopped covering a file. If an
    // entry no longer matches, delete the entry — do not leave the exemption.
    for (const rel of Object.keys(ALLOWED)) {
      expect(
        swept.files,
        `${rel} (${ALLOWED[rel]}) was not reached by the walk`
      ).toContain(rel);
      expect(
        slicesByPosition(fs.readFileSync(path.join(REPO, rel), "utf8")),
        `${rel} no longer slices by position — remove its allowlist entry`
      ).toBe(true);
    }
    expect(
      swept.files,
      "this file must be inside its own scanned roots"
    ).toContain(SELF);
  });

  it("sees the spellings it exists to catch", () => {
    // A green sweep over a complying tree says nothing about what the sweep can
    // see. These are the real shapes, including the one #3565 was filed for.
    for (const broken of [
      "runMigrations(db, MIGRATIONS.slice(0, -1));",
      "runMigrations(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1));",
      "runMigrations(mem, MIGRATIONS.slice(0, 116));",
      "for (const m of MIGRATIONS.slice(0, target)) m.up(db);",
      'const target = MIGRATIONS.findIndex((m) => m.name === "20260814-x");',
    ]) {
      expect(slicesByPosition(broken), broken).toBe(true);
    }
  });

  it("stays silent on the sanctioned neighbours", () => {
    for (const fine of [
      'runMigrations(db, migrationsBefore("20260814-remove-legacy-schema-shells"));',
      "for (const m of NUMBERED_MIGRATIONS.filter((m) => m.id < V162)) m.up(db);",
      "for (const m of NUMBERED_MIGRATIONS) if (m.id <= maxId) m.up(mem);",
      "const m041 = MIGRATIONS.find((m) => m.id === 41)!;",
      "MIGRATIONS[0].up(db); // 001-baseline",
      "MIGRATIONS[V162 - 1].up(db);",
      "runMigrations(db, MIGRATIONS);",
      "expect(readVersion(db)).toBe(MIGRATIONS.length);",
      "// prose: a fixture must never use MIGRATIONS.slice(0, -1) again",
    ]) {
      expect(slicesByPosition(fine), fine).toBe(false);
    }
  });
});

// ── THE OFFENDER IS PLANTED IN A CORPUS, NOT HANDED TO THE MATCHER ─────────
//
// The two tests above hand STRINGS to `slicesByPosition`. They prove the
// MATCHER. They say nothing about the WALK — which root it enters, whether it
// recurses, which extensions it matches — and the walk is where this census
// failed review. So one offender is written to disk inside a scanned root and
// the WHOLE census is re-run over it.
//
// It is planted in a `mkdtemp` corpus rather than in the live tree: vitest runs
// test files concurrently and other guards walk these same directories, so a
// plant-then-unlink in `lib/__tests__` hands them an ENOENT in tests that have
// nothing to do with migrations (#3557 review). Same walk, different base.
describe("the census walk reaches a planted offender", () => {
  // A corpus with a shape, so the readings below are not two zeroes agreeing:
  // one fixture that already offends, one that is clean, and the plant in a
  // SUBDIRECTORY of a root added in this round — so finding it proves the walk
  // recurses AND that `e2e/` is really being entered.
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-fixture-corpus-")
  );
  const corpus: Corpus = { base, roots: ROOTS };
  const plantedRel = "e2e/planted/zz-planted-fixture.ts";
  const planted = path.join(base, plantedRel);

  beforeAll(() => {
    for (const root of ROOTS)
      fs.mkdirSync(path.join(base, root), { recursive: true });
    fs.mkdirSync(path.join(base, "e2e", "planted"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "lib/__db_tests__/seed-clean.test.ts"),
      'runMigrations(db, migrationsBefore("20260101-seed"));\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(base, "lib/__db_tests__/seed-offender.test.ts"),
      "runMigrations(db, MIGRATIONS.slice(0, -1));\n",
      "utf8"
    );
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("flags a fixture the walk had to find on disk", () => {
    const before = census(corpus).offenders;
    expect(
      before,
      "The seeded corpus holds one fixture that slices by position and the walk " +
        "found none of it. Both readings would then be empty and would agree, " +
        "which is the shape of a walk that has stopped walking — not of a pass."
    ).toEqual(["lib/__db_tests__/seed-offender.test.ts"]);

    fs.writeFileSync(
      planted,
      "export function beforeX() {\n" +
        "  return runMigrations(db, MIGRATIONS.slice(0, -1));\n" +
        "}\n",
      "utf8"
    );
    const after = census(corpus).offenders;
    expect(
      after,
      `The census did not see a file written to disk at \`${plantedRel}\` inside ` +
        `a scanned root. The matcher's own tests cannot tell you this: it is the ` +
        `WALK that failed — a root it does not enter, a directory it does not ` +
        `recurse into, or an extension it no longer matches.`
    ).toContain(plantedRel);
    // Additive, not a rewrite of what the sweep was already reporting.
    expect(after.length).toBe(before.length + 1);
  });

  it("stays quiet on a planted fixture that slices by name", () => {
    // The baseline is taken with NOTHING planted. Reading it while the previous
    // test's offender is still on disk measures the wrong tree, and it fails
    // toward "the clean plant removed a finding" — the reassuring direction.
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    const before = census(corpus).offenders;
    fs.writeFileSync(
      planted,
      "export function beforeX() {\n" +
        '  return runMigrations(db, migrationsBefore("20260814-x"));\n' +
        "}\n",
      "utf8"
    );
    const scan = census(corpus);
    expect(
      scan.offenders,
      "The census flagged a fixture that slices by NAME. A guard that cries " +
        "wolf on the remedy it recommends is deleted, and the rule goes with it."
    ).toEqual(before);
    // …and it really was walked, rather than silently skipped.
    expect(scan.files).toContain(plantedRel);
  });

  // AND THE CORPUS PARAMETER IS NOT A SEPARATE CODE PATH. The two tests above
  // are only worth something if the walk they exercise is the walk the tree
  // gets: same function, same filters, same recursion, one argument different.
  it("is the same walk the tree itself is swept with", () => {
    expect(sourceFiles("lib/__db_tests__")).toContain(
      "lib/__db_tests__/runner.test.ts"
    );
    expect(sourceFiles("lib/__db_tests__", base)).toContain(
      "lib/__db_tests__/seed-offender.test.ts"
    );
    // The tree's walk cannot see the temp corpus and the temp corpus's walk
    // cannot see the tree — which is the whole point of the move.
    expect(sourceFiles("lib/__db_tests__", base)).not.toContain(
      "lib/__db_tests__/runner.test.ts"
    );
  });
});

describe("the walk's own reach", () => {
  it("refuses a root that does not exist instead of reporting zero findings", () => {
    // The exact mutant review's control survived: point a root at nothing and the
    // census swept no files, found no offenders, and passed.
    expect(() => sourceFiles("lib/__nonexistent__")).toThrow(/does not exist/);
    expect(() =>
      census({ base: REPO, roots: ["lib/__nonexistent__"] })
    ).toThrow(/does not exist/);
  });

  it("does not wander outside the scanned roots", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "migration-fixture-out-")
    );
    try {
      fs.writeFileSync(
        path.join(dir, "Outside.ts"),
        "runMigrations(db, MIGRATIONS.slice(0, -1));\n",
        "utf8"
      );
      expect(swept.files.some((f) => f.includes("Outside"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
