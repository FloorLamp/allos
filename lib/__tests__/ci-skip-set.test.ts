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
// The entries at risk are the ones naming a directory of IMPORTABLE CODE. Prose
// cannot grow an importer. But `lib/__tests__/`, `lib/__db_tests__/` and
// `lib/__action_tests__/` sit UNDER `lib/`, beside modules the app imports
// constantly, and they legitimately contain non-test modules —
// `lib/__db_tests__/migration-link-scan.ts` is the scanner #2721's two guards
// share. The day a non-test consumer reaches into one, the entry has to go, and
// this test is what says so.
//
// `scripts/orchestration/` IS CODE TOO (#2786). It shipped unverified on the
// argument that nothing imports it today — which is the same argument AGENTS.md
// made about the three test directories, and precisely why those got a guard
// rather than a sentence. `dispatch-brief.mjs`, `reconcile-tracker-core.ts` and
// their neighbours are exactly the shape a `scripts/` sibling starts reaching
// into, and the moment one does, a change there skips the browser matrix while
// genuinely affecting the app. Before #2769 extending the scan would have
// inherited a matcher blind to the relative form; now it costs one entry.
//
// EVERY ENTRY IS NOW CLASSIFIED, which is the wider half of that fix. The old
// filter took the entries starting with `lib/` and silently ignored the rest, so a
// new code directory added to `ci.yml` got no guard AND no notice — the failure
// mode this whole family exists to prevent, one level up. An entry is now either
// verified by the census below or declared unverifiable WITH ITS REASON, and the
// two together must equal the live regex.
//
// `.claude/skills/` stays deliberately unverified. Guarding it would mean deciding
// what "reachable" means for a skill file, which is not an import-graph question,
// and a guard extended to something it cannot honestly judge is worse than a
// stated gap.
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

let entries: string[] | null = null;

/**
 * The alternation inside the workflow's `grep -qvE '^(…)'` detector.
 *
 * Memoized: #2769 found this being re-read and re-regexed inside a filter over
 * ~2,500 files (209 ms → 864 ms), and every assertion below wants the same list.
 */
function skipSetEntries(): string[] {
  if (entries) return entries;
  const src = fs.readFileSync(WORKFLOW, "utf8");
  const match = /grep -qvE '\^\((.+?)\)'/.exec(src);
  expect(
    match,
    "the no-runtime-surface detector in .github/workflows/ci.yml no longer matches " +
      "`grep -qvE '^(…)'` — this guard reads the live regex rather than a copy, so " +
      "reshaping the detector means reshaping this scan with it"
  ).not.toBeNull();
  entries = match![1].split("|").map((e) => e.replace(/\\/g, ""));
  return entries;
}

/**
 * The entries this scan VERIFIES: directories of importable code, where "nothing
 * reachable imports this" is an import-graph question with an answer.
 */
const VERIFIED_DIRS = [
  "lib/__action_tests__/",
  "lib/__db_tests__/",
  "lib/__tests__/",
  "scripts/orchestration/",
] as const;

/** The entries this scan deliberately does NOT verify, each with its reason. */
const UNVERIFIED_ENTRIES: Record<string, string> = {
  "README.md": "prose; a Markdown file cannot become an import",
  "SECURITY.md": "prose; a Markdown file cannot become an import",
  LICENSE: "not a module in any language",
  "AGENTS.md": "prose; the agent one-pager, guarded for length not for imports",
  "CLAUDE.md": "a symlink to AGENTS.md, same reason",
  "docs/": "prose; the whole point of the directory",
  ".claude/skills/":
    "read by Claude Code and one pure test. Deciding what 'reachable' means " +
    "for a skill file is not an import-graph question, and a guard extended to " +
    "something it cannot honestly judge reads as coverage while providing none",
  "scripts/orchestrator-checkin.sh$":
    "a shell script, which no import specifier in this repo can name. A module " +
    "SHELLING OUT to it is a real reach and is out of this scan's sight — " +
    "asserted as a gap below rather than left to be discovered",
};

/**
 * The verified entries, taken from the LIVE regex.
 *
 * Read out of the workflow rather than from the constant, for the same reason the
 * whole file does: deleting an entry from `ci.yml` removes its case here instead
 * of leaving an assertion that passes vacuously. The census below is what makes
 * the deletion a deliberate edit rather than a silent loss.
 */
function verifiedDirs(): string[] {
  return skipSetEntries().filter((e) =>
    (VERIFIED_DIRS as readonly string[]).includes(e)
  );
}

let walked: string[] | null = null;

/**
 * Every source file the app, the browser harness, or the non-orchestration scripts
 * could load — i.e. everything whose import of a skipped directory would mean the
 * browser CAN reach it.
 *
 * The verified directories are pruned as a SET, not one at a time, and that is the
 * property that makes one hop enough. CI drops the matrix for a diff whose every
 * path is in the union, so a reach from one skipped directory into another
 * falsifies neither — `lib/__tests__/reconcile-tracker.test.ts` really does import
 * `scripts/orchestration/reconcile-tracker-core`, and both entries are still
 * honest. Any path from runtime code into the union must cross the boundary
 * exactly once, and that crossing is what this scans for.
 */
function runtimeSourceFiles(): string[] {
  // Memoized: the walk crosses most of the repo and several assertions below want
  // the same list. Nothing writes to the tree during a run.
  if (walked) return walked;
  const roots = ["app", "components", "e2e", "middleware.ts", "scripts", "lib"];
  const skipped = verifiedDirs();
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

  it("classifies EVERY entry as verified or unverifiable-with-a-reason", () => {
    // #2786. The old filter took the entries starting with `lib/` and ignored the
    // rest, so adding a code directory to ci.yml bought no guard and raised no
    // objection. Now the two classifications must together equal the live regex:
    // a new entry fails HERE until someone has answered "can an import graph judge
    // this?", which is the moment to re-ask "what imports this".
    expect(
      [...VERIFIED_DIRS, ...Object.keys(UNVERIFIED_ENTRIES)].sort(),
      "an entry in .github/workflows/ci.yml is neither verified by this scan nor " +
        "declared unverifiable with a reason. Add it to VERIFIED_DIRS if it names " +
        "a directory of importable code, or to UNVERIFIED_ENTRIES with the reason " +
        "an import graph cannot judge it."
    ).toEqual(skipSetEntries().sort());
    // Non-vacuous in the direction that matters: the verified set is not empty of
    // the entry this issue was about, and every reason is a reason.
    expect(verifiedDirs()).toContain("scripts/orchestration/");
    for (const [entry, reason] of Object.entries(UNVERIFIED_ENTRIES))
      expect(reason.length, entry).toBeGreaterThan(20);
  });

  it("holds: nothing the browser can reach imports a skipped directory", () => {
    const offenders = offendersIn(runtimeSources(), verifiedDirs());
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
        verifiedDirs()
      )
    ).toEqual(["lib/queries/probe.ts → ../__db_tests__/migration-link-scan"]);
  });

  it("sees a reach into scripts/orchestration, which is CODE", () => {
    // #2786's mutation. Against the pre-fix scan — whose verified set was the
    // entries starting with `lib/` — every one of these returned nothing, because
    // the entry was not being checked at all. A `scripts/` sibling importing the
    // dispatch helper is the concrete way this entry goes wrong: the diff touches
    // only `scripts/orchestration/`, CI drops the twelve-shard browser matrix, and
    // a module the app loads changed behaviour underneath it.
    const reaches = [
      ["scripts/notify.ts", "./orchestration/dispatch-brief.mjs"],
      ["scripts/seed.ts", "../scripts/orchestration/pr-board.mjs"],
      ["lib/queries/probe.ts", "@/scripts/orchestration/reconcile-patch"],
      ["app/api/probe/route.ts", "../../../scripts/orchestration/ci-watch.mjs"],
      ["components/Probe.tsx", "scripts/orchestration/reconcile-tracker-core"],
    ] as const;
    const preFix = verifiedDirs().filter((dir) => dir.startsWith("lib/"));
    for (const [file, spec] of reaches) {
      const source = [{ file, src: `import { x } from "${spec}";` }];
      expect(
        offendersIn(source, verifiedDirs()),
        `${file} → ${spec}`
      ).toHaveLength(1);
      // The control, and the whole of #2786: against the set the pre-fix version
      // verified, every one of these is invisible.
      expect(
        offendersIn(source, preFix),
        `${file} → ${spec} under the pre-fix verified set`
      ).toEqual([]);
    }
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
          verifiedDirs()
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
      // #2786's near-misses. `scripts/orchestrator-checkin.sh` is a DIFFERENT
      // skip-set entry whose name shares a prefix with the directory, and a
      // sibling directory one character off is the mistake a prefix test makes.
      'import { x } from "../../scripts/orchestrator-checkin";',
      'import { x } from "../../scripts/orchestration-helpers/x";',
    ];
    for (const src of quiet)
      expect(
        offendersIn([{ file: "lib/queries/probe.ts", src }], verifiedDirs()),
        src
      ).toEqual([]);
  });

  it("exempts a file INSIDE a skipped directory, which is the point of one", () => {
    // Deliberate and load-bearing: `lib/__db_tests__/migration-link-scan.ts` is
    // imported by its neighbours constantly, and that is not a reach from outside.
    // The exemption lives in the WALK, so it is asserted there — and it is not
    // vacuous, because the shared module the whole entry is about really is in one.
    const skipped = verifiedDirs();
    const inside = runtimeSourceFiles().filter((f) =>
      skipped.some((dir) => f.startsWith(dir))
    );
    expect(inside).toEqual([]);
    expect(
      fs.existsSync(path.join(REPO, "lib/__db_tests__/migration-link-scan.ts"))
    ).toBe(true);
    // And the new directory really is one of the pruned ones, not a set member
    // that happens to have no files: the walk must have skipped real code.
    expect(
      fs.readdirSync(path.join(REPO, "scripts/orchestration")).length
    ).toBeGreaterThan(0);
  });

  it("exempts a reach BETWEEN two skipped directories, and really has one", () => {
    // The exemption generalizes from "inside one entry" to "inside the union"
    // (#2786), because CI drops the matrix for a diff whose every path is in the
    // union — so a reach that never leaves it cannot make a skipped diff unsafe.
    //
    // Non-vacuous, and this is the whole reason to assert it: the reach is real.
    // `lib/__tests__/reconcile-tracker.test.ts` imports the orchestration module
    // it tests. Verify BOTH entries naively, one file at a time, and that honest
    // import is an offender against `scripts/orchestration/`.
    const file = "lib/__tests__/reconcile-tracker.test.ts";
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
    expect(src).toContain("scripts/orchestration/reconcile-tracker-core");
    expect(offendersIn([{ file, src }], verifiedDirs()).length).toBeGreaterThan(
      0
    );
    // The walk is what makes it a non-offender: the file is never scanned.
    expect(runtimeSourceFiles()).not.toContain(file);
  });

  it("states what it CANNOT see", () => {
    // A guard credited with more than it does is worse than none, so the gaps are
    // asserted rather than left to be discovered. THREE things are out of reach
    // and no text scan fixes any of them.
    //
    // A specifier assembled at runtime: there is no literal to resolve.
    const computed =
      'const dir = "../__db_tests__";\n' +
      "await import(`${dir}/migration-link-scan`);";
    expect(
      offendersIn(
        [{ file: "lib/queries/probe.ts", src: computed }],
        verifiedDirs()
      )
    ).toEqual([]);
    // A module in a language the walk does not collect: only TS and ESM JS
    // sources are read, so a plain `.js` or `.cjs` reach is invisible.
    expect(
      runtimeSourceFiles().every((f) => /\.(ts|tsx|mts|mjs)$/.test(f))
    ).toBe(true);
    // And EXECUTION IS NOT IMPORT (#2786). Shelling out to a script reaches it
    // just as surely, and there is no specifier to resolve — which is also why
    // `scripts/orchestrator-checkin.sh` is declared unverifiable rather than
    // verified. Naming this gap is the honest move; a partial exec-detector that
    // caught the string form and missed the assembled one would read like a total
    // rule and be the #2444 shape all over again.
    const shelled =
      'execFileSync("bash", ["scripts/orchestration/agent-gates.sh"]);';
    expect(
      offendersIn([{ file: "scripts/notify.ts", src: shelled }], verifiedDirs())
    ).toEqual([]);
    expect(
      fs.existsSync(path.join(REPO, "scripts/orchestration/agent-gates.sh"))
    ).toBe(true);
  });
});
