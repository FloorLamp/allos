// The no-runtime-surface skip set is a CLAIM ABOUT IMPORTS (#61/#2627/#2708), and
// this is the guard that keeps it true.
//
// `.github/workflows/ci.yml` drops the twelve-shard browser matrix for a diff whose
// every path matches one literal alternation. Each entry says "the running app
// cannot reach this", and AGENTS.md requires the set grow only against the question
// "what imports this" — but an import graph moves, and nothing was checking. A
// wrong entry does not fail: it silently stops running the browser suite for a
// change that needed it, which is the shape of guard this repo has paid for twice
// (#2444's registry naming columns that never existed, #2677's entries nobody
// exercised). So the claim is asserted rather than restated.
//
// The three TEST-DIRECTORY entries are the ones at risk. Prose cannot grow an
// importer, and `.claude/skills/` is read only by Claude Code and one pure test.
// But `lib/__tests__/`, `lib/__db_tests__/` and `lib/__action_tests__/` sit UNDER
// `lib/`, beside modules the app imports constantly, and they legitimately contain
// non-test modules — `lib/__db_tests__/migration-link-scan.ts` is the scanner
// #2721's two guards share. The day a non-test consumer reaches into one, the entry
// has to go, and this test is what says so.
//
// The regex is READ OUT OF THE WORKFLOW rather than restated here, for the same
// reason #2721's census reads FK parents out of the schema: a copy of the list
// cannot judge the list. Deleting an entry from ci.yml removes its case here
// instead of leaving an assertion that passes vacuously.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WORKFLOW = path.join(REPO, ".github/workflows/ci.yml");

/** The alternation inside the workflow's `grep -qvE '^(…)'` detector. */
function skipSetEntries(): string[] {
  const src = fs.readFileSync(WORKFLOW, "utf8");
  const match = /grep -qvE '\^\((.+?)\)'/.exec(src);
  expect(
    match,
    "the no-runtime-surface detector in .github/workflows/ci.yml no longer matches " +
      "`grep -qvE '^(…)'` — this guard reads the live regex rather than a copy, so " +
      "reshaping the detector means reshaping this scan with it"
  ).not.toBeNull();
  return match![1].split("|").map((e) => e.replace(/\\/g, ""));
}

/** The skip-set entries that name a directory under `lib/`. */
function testDirEntries(): string[] {
  return skipSetEntries().filter(
    (e) => e.startsWith("lib/") && e.endsWith("/")
  );
}

/**
 * Every source file the app, the browser harness, or the non-orchestration scripts
 * could load — i.e. everything whose import of a skipped directory would mean the
 * browser CAN reach it.
 */
function runtimeSourceFiles(): string[] {
  const roots = ["app", "components", "e2e", "middleware.ts", "scripts", "lib"];
  const skipped = testDirEntries();
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isFile()) {
      if (/\.(ts|tsx|mts|mjs)$/.test(rel)) out.push(rel);
      return;
    }
    if (rel.includes("node_modules") || path.basename(rel) === ".next") return;
    // A file INSIDE a skipped directory may import its neighbours freely — that is
    // what the directory is for. Only reaches from OUTSIDE falsify the entry.
    if (skipped.some((dir) => `${rel}/`.startsWith(dir))) return;
    for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry));
  };
  for (const root of roots) walk(root);
  return out;
}

describe("the CI no-runtime-surface skip set", () => {
  it("is not vacuous — the workflow still declares one", () => {
    const entries = skipSetEntries();
    expect(entries.length).toBeGreaterThan(3);
    expect(entries).toContain("docs/");
  });

  it("names the test directories it claims nothing reachable imports", () => {
    // Stated so that REMOVING an entry is a deliberate edit here too, rather than a
    // silent loss of the case below. Adding a fourth test directory to ci.yml means
    // adding it here, which is the moment to re-ask "what imports this".
    expect(testDirEntries().sort()).toEqual([
      "lib/__action_tests__/",
      "lib/__db_tests__/",
      "lib/__tests__/",
    ]);
  });

  it("holds: nothing the browser can reach imports a skipped test directory", () => {
    const skipped = testDirEntries();
    const offenders: string[] = [];
    for (const file of runtimeSourceFiles()) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      // Import and require FORMS only — a bare mention in a comment is how these
      // directories are legitimately cross-referenced all over the app (a module
      // naming the test that pins it), and treating that as an import would fail
      // on ~20 honest comments while proving nothing.
      for (const m of src.matchAll(
        /(?:from\s+|import\s*\(|require\s*\()\s*["'`]([^"'`]+)["'`]/g
      )) {
        const spec = m[1].replace(/^@\//, "");
        if (skipped.some((dir) => spec.startsWith(dir))) {
          offenders.push(`${file} → ${m[1]}`);
        }
      }
    }
    expect(
      offenders,
      "a reachable module imports a directory the CI skip set claims the running " +
        "app cannot reach, so a change to that directory would skip the browser " +
        "matrix while genuinely affecting the browser. Either drop the entry from " +
        ".github/workflows/ci.yml, or move the shared module out of the test tree."
    ).toEqual([]);
  });
});
