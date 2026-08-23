import { describe, it, expect } from "vitest";
import fs from "node:fs";
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
// What this scan does NOT flag, deliberately — a guard that cried wolf on these
// would be deleted within a week, taking the real guard with it:
//   * `MIGRATIONS[0]`, `MIGRATIONS[14]`, `MIGRATIONS[V162 - 1]` — reaching for
//     ONE migration's `up()` in the CLOSED numbered era, where id === position+1
//     is frozen and asserted. Those indexes cannot drift.
//   * `NUMBERED_MIGRATIONS.filter((m) => m.id < N)` — the numbered era's own
//     remedy, already name-safe because ids are frozen.
//   * `MIGRATIONS.find((m) => m.id === 41)` — identity by id, not by position.
const ROOT = path.join(__dirname, "..", "..");
const TIER_DIRS = ["lib/__tests__", "lib/__db_tests__", "lib/__action_tests__"];

// This file holds the forbidden spellings as data; scanning itself would be a
// self-match, not a finding.
const SELF = path.relative(ROOT, __filename).split(path.sep).join("/");

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

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("historical-shape fixtures slice by name, not by array position", () => {
  it("no test tier builds a 'before' database by position", () => {
    const offenders: string[] = [];
    for (const dir of TIER_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (rel === SELF || rel in ALLOWED) continue;
        if (slicesByPosition(fs.readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      "These files slice MIGRATIONS by position to build a historical " +
        "database. Position is not identity: the slice means what its author " +
        "intended on exactly one day, then silently rebuilds the future into " +
        "the 'before' database and keeps passing. Use " +
        "`migrationsBefore(\"<migration name>\")` from " +
        `@/lib/migrations/versions instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlist entry still slices by position", () => {
    // A stale allowlist is a scan that has quietly stopped covering a file. If an
    // entry no longer matches, delete the entry — do not leave the exemption.
    for (const rel of Object.keys(ALLOWED)) {
      const full = path.join(ROOT, rel);
      expect(fs.existsSync(full), `${rel} (${ALLOWED[rel]}) no longer exists`).toBe(
        true
      );
      expect(
        slicesByPosition(fs.readFileSync(full, "utf8")),
        `${rel} no longer slices by position — remove its allowlist entry`
      ).toBe(true);
    }
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
