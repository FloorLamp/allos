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
//
// A SPECIFIER IS RESOLVED, NEVER PREFIX-TESTED (#2769). The first version of this
// scan compared the raw specifier against `lib/__db_tests__/`, so it saw the alias
// and bare forms and was blind to `../__db_tests__/x` — the form a module under
// `lib/` reaching a sibling directory is written with by default, and the form
// non-test `lib/` outnumbers the alias one by better than ten to one. The guard
// therefore read like a total rule while covering the rarer spelling of it, which
// is the #2444 shape one level up: it does not fail, it stops guarding.

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

let walked: string[] | null = null;

/**
 * Every source file the app, the browser harness, or the non-orchestration scripts
 * could load — i.e. everything whose import of a skipped directory would mean the
 * browser CAN reach it.
 */
function runtimeSourceFiles(): string[] {
  // Memoized: the walk crosses most of the repo and several assertions below want
  // the same list. Nothing writes to the tree during a run.
  if (walked) return walked;
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
  walked = out;
  return out;
}

/**
 * The specifiers a source file imports.
 *
 * Import and require FORMS only — a bare mention in a comment is how these
 * directories are legitimately cross-referenced all over the app (a module naming
 * the test that pins it), and treating that as an import would fail on ~20 honest
 * comments while proving nothing.
 */
function importSpecifiers(src: string): Iterable<string> {
  const matches = src.matchAll(
    /(?:from\s+|import\s*\(|require\s*\()\s*["'`]([^"'`]+)["'`]/g
  );
  return (function* () {
    for (const m of matches) yield m[1];
  })();
}

/** The repo-relative path a specifier names, as written from `fromFile`. */
function resolveSpecifier(fromFile: string, spec: string): string {
  if (spec.startsWith("."))
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), spec)
    );
  if (spec.startsWith("@/")) return spec.slice(2);
  // Anything else is a package name, and stays as written: `node:fs` and `vitest`
  // cannot name a repo directory, and a bare `lib/…` — which tsconfig does not map
  // — is still reported rather than excused, because a reach that does not resolve
  // is a mistake to surface, not one to trust to stay broken.
  return spec;
}

type SourceFile = { file: string; src: string };

/** The scanned files and their text, read one at a time rather than all at once. */
function* runtimeSources(): Generator<SourceFile> {
  for (const file of runtimeSourceFiles())
    yield { file, src: fs.readFileSync(path.join(REPO, file), "utf8") };
}

/** Reaches from `files` into a skipped directory, as `file → specifier`. */
function offendersIn(
  files: Iterable<SourceFile>,
  skipped: readonly string[]
): string[] {
  const out: string[] = [];
  for (const { file, src } of files) {
    for (const spec of importSpecifiers(src)) {
      const resolved = resolveSpecifier(file, spec);
      if (skipped.some((dir) => resolved.startsWith(dir)))
        out.push(`${file} → ${spec}`);
    }
  }
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
    const offenders = offendersIn(runtimeSources(), testDirEntries());
    expect(
      offenders,
      "a reachable module imports a directory the CI skip set claims the running " +
        "app cannot reach, so a change to that directory would skip the browser " +
        "matrix while genuinely affecting the browser. Either drop the entry from " +
        ".github/workflows/ci.yml, or move the shared module out of the test tree."
    ).toEqual([]);
  });
});

// The census above is only as good as what the matcher can SEE, and a green census
// is exactly what a blind matcher produces. So the reach is exercised rather than
// spelled (#2677): each case below is a reach that would have to fail, run through
// the same `offendersIn` the real census uses.
describe("the skip-set scan's reach", () => {
  it("sees the RELATIVE form, which is the one the repo actually writes", () => {
    // #2769's mutation, made permanent. Against the pre-fix matcher this exact
    // file passed — a runtime-reachable `lib/` module importing the shared scanner
    // that lives in a skipped directory, invisible because the specifier does not
    // literally begin with `lib/`.
    expect(
      offendersIn(
        [
          {
            file: "lib/queries/probe.ts",
            src: 'import { x } from "../__db_tests__/migration-link-scan";',
          },
        ],
        testDirEntries()
      )
    ).toEqual(["lib/queries/probe.ts → ../__db_tests__/migration-link-scan"]);
  });

  it("sees one reach in every spelling, from every scanned root", () => {
    const reaches = [
      ["lib/queries/probe.ts", "../__db_tests__/migration-link-scan"],
      ["lib/queries/probe.ts", "@/lib/__db_tests__/migration-link-scan"],
      ["lib/queries/probe.ts", "lib/__db_tests__/migration-link-scan"],
      ["lib/deep/nested/probe.ts", "../../__tests__/probe"],
      ["lib/probe.ts", "./__action_tests__/probe"],
      ["app/(app)/trends/page.tsx", "../../../lib/__tests__/probe"],
      ["scripts/notify.ts", "../lib/__db_tests__/migration-link-scan"],
      ["components/Probe.tsx", "@/lib/__action_tests__/probe"],
      ["e2e/probe.spec.ts", "../lib/__tests__/probe"],
    ] as const;
    for (const [file, spec] of reaches) {
      expect(
        offendersIn(
          [{ file, src: `import { x } from "${spec}";` }],
          testDirEntries()
        ),
        `${file} → ${spec}`
      ).toHaveLength(1);
    }
  });

  it("stays quiet on packages, siblings, and honest comments", () => {
    // The other half of a widened matcher: it must not have become a matcher for
    // everything. A near-miss directory name and a prose mention are the two the
    // scan meets constantly.
    const quiet = [
      'import fs from "node:fs";',
      'import { describe } from "vitest";',
      'import { db } from "@/lib/db";',
      'import { helper } from "./sibling";',
      'import { x } from "../__db_tests_helper/x";',
      "// see lib/__tests__/ci-skip-set.test.ts, which pins this",
      "/* pinned by lib/__db_tests__/migration-child-links.test.ts */",
    ];
    for (const src of quiet)
      expect(
        offendersIn([{ file: "lib/queries/probe.ts", src }], testDirEntries()),
        src
      ).toEqual([]);
  });

  it("exempts a file INSIDE a skipped directory, which is the point of one", () => {
    // Deliberate and load-bearing: `lib/__db_tests__/migration-link-scan.ts` is
    // imported by its neighbours constantly, and that is not a reach from outside.
    // The exemption lives in the WALK, so it is asserted there — and it is not
    // vacuous, because the shared module the whole entry is about really is in one.
    const skipped = testDirEntries();
    const inside = runtimeSourceFiles().filter((f) =>
      skipped.some((dir) => f.startsWith(dir))
    );
    expect(inside).toEqual([]);
    expect(
      fs.existsSync(path.join(REPO, "lib/__db_tests__/migration-link-scan.ts"))
    ).toBe(true);
  });

  it("states what it CANNOT see", () => {
    // A guard credited with more than it does is worse than none, so the gap is
    // asserted rather than left to be discovered. TWO things are out of reach and
    // no text scan fixes either.
    //
    // A specifier assembled at runtime: there is no literal to resolve.
    const computed =
      'const dir = "../__db_tests__";\n' +
      "await import(`${dir}/migration-link-scan`);";
    expect(
      offendersIn(
        [{ file: "lib/queries/probe.ts", src: computed }],
        testDirEntries()
      )
    ).toEqual([]);
    // And a module in a language the walk does not collect: only TS and ESM JS
    // sources are read, so a plain `.js` or `.cjs` reach is invisible.
    expect(
      runtimeSourceFiles().every((f) => /\.(ts|tsx|mts|mjs)$/.test(f))
    ).toBe(true);
  });
});
