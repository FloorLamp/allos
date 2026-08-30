// The `test:db` gate's trigger set is a CLAIM ABOUT IMPORTS (#2954), and this is
// the guard that keeps it true.
//
// `scripts/orchestration/agent-gates.sh` runs the DB+action tier only when the diff
// touches `db_tier_paths` — the expensive gate stops firing for an agent whose work
// is confined to docs/, e2e/ or scripts/orchestration/. Each entry says "the tier's
// inputs live here", which is the same shape of claim as CI's no-runtime-surface
// skip set, and it fails the same silent way: a wrong set does not go red, it
// quietly stops running the DB tests for a change that needed them. #2786 settled
// how this repo answers that — walk the imports, do not trust the list — and this
// applies it to the second consumer of the same idea.
//
// TWO DIRECTIONS, both load-bearing, because the set can be wrong either way:
//
//   - TOO NARROW is the dangerous one: the tier reaches a path no entry covers, a
//     diff touching only that path skips the gate, and the DB tests that would have
//     caught the break never ran. That is the census below.
//   - TOO WIDE quietly repeals the fix: an entry covering docs/ or e2e/ makes the
//     gate fire for every agent again, and nothing would ever say so. So the
//     directories the change exists to spare are asserted as NOT covered.
//
// THE SET IS READ OUT OF THE SCRIPT, not restated here, for the reason #2721's
// census reads FK parents out of the schema and #2786's reads the live regex out of
// the workflow: a copy of a list cannot judge the list. Editing `db_tier_paths`
// re-runs this walk against the edit instead of leaving an assertion that passes
// vacuously.
//
// The seeds are read out of `vitest.db.config.ts` for the same reason — the tier's
// include globs ARE the definition of what runs, so reshaping them reshapes the
// walk. A hardcoded pair of directory names would keep passing after the config
// grew a third.
//
// WHAT THE WALK FOUND, recorded because it corrected the issue's own guess: the
// tier reaches `middleware.ts` (executed by `lib/__db_tests__/auth.test.ts`),
// `scripts/seed-personas.ts` (executed by its DB test), ~30 `scripts/gen-*.ts`
// generators whose types the `lib/datasets/` modules re-export, and
// `components/activity/ActivityMediaStrip.tsx` via a training Server Action. #2954
// predicted `components/` was unreachable and said to confirm before including it;
// the walk said otherwise, which is the whole argument for walking.
//
// A SPECIFIER IS RESOLVED, NEVER PREFIX-TESTED (the #2769 lesson, inherited): the
// relative form is what a module reaching a sibling directory actually writes, so
// matching `lib/` against raw specifiers would read like a total rule while seeing
// the rarer spelling of it.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GATES = "scripts/orchestration/agent-gates.sh";
const DB_CONFIG = "vitest.db.config.ts";

type TriggerSet = { include: string[]; exclude: string[] };

let triggers: TriggerSet | null = null;

/**
 * The `db_tier_paths` array from the gate script, split into git's positive and
 * `:(exclude)` pathspecs.
 *
 * Memoized: every assertion below wants the same set, and #2769 found the re-read
 * of a workflow inside a filter costing four times the whole scan.
 */
function triggerSet(): TriggerSet {
  if (triggers) return triggers;
  const src = fs.readFileSync(path.join(REPO, GATES), "utf8");
  // Lazy to the closing paren ON ITS OWN LINE — an entry may contain one, and
  // `:(exclude)…` (the entry this scan most needs to read) always does.
  const match = /db_tier_paths=\(\n([\s\S]*?)\n\)/.exec(src);
  expect(
    match,
    `the \`db_tier_paths=( … )\` array in ${GATES} no longer parses — this guard ` +
      "reads the live array rather than a copy, so reshaping how the gate declares " +
      "its trigger set means reshaping this scan with it"
  ).not.toBeNull();
  const entries = match![1]
    .split("\n")
    .map((line) => line.trim().replace(/^["']|["']$/g, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  triggers = {
    include: entries.filter((e) => !e.startsWith(":(exclude)")),
    exclude: entries
      .filter((e) => e.startsWith(":(exclude)"))
      .map((e) => e.slice(":(exclude)".length)),
  };
  return triggers;
}

/** Does the trigger set cover this repo-relative path, the way git's pathspec would? */
function covered(rel: string, set: TriggerSet = triggerSet()): boolean {
  const hit = (spec: string) =>
    spec.endsWith("/") ? rel.startsWith(spec) : rel === spec;
  return set.include.some(hit) && !set.exclude.some(hit);
}

/** Every `.ts`/`.tsx`/`.mts`/`.mjs` file under a directory, repo-relative. */
function sourcesUnder(dir: string, out: string[] = []): string[] {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs)) {
    const rel = path.posix.join(dir, entry);
    if (fs.statSync(path.join(REPO, rel)).isDirectory()) sourcesUnder(rel, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(rel)) out.push(rel);
  }
  return out;
}

/**
 * The files the tier starts from: the config itself plus everything under the
 * directories its include globs, isolation scan and setup files name.
 *
 * Taken from the config's string literals — a glob's fixed prefix is the directory
 * it covers, and a setup file is its own seed. `lib/__db_tests__/**\/*.test.ts`,
 * `lib/__action_tests__` and `lib/__db_tests__/setup-shared.ts` all reduce to the
 * two directories, and a third one added tomorrow reduces to itself.
 */
function seedFiles(): string[] {
  const whole = fs.readFileSync(path.join(REPO, DB_CONFIG), "utf8");
  // Everything before `coverage:`. The coverage block's globs describe what is
  // MEASURED (`lib/**`), not what RUNS, and seeding from them would drag the whole
  // of lib/ in as a seed — harmless for the census, but it would turn the
  // transitivity assertions below into tautologies.
  expect(
    whole,
    `${DB_CONFIG} no longer separates its run set from its coverage set`
  ).toContain("coverage:");
  const src = whole.split(/\n\s*coverage:/)[0];
  const seeds = new Set<string>([DB_CONFIG]);
  // Quotes only, NOT backticks: this repo cites paths in backticks inside prose,
  // and the config's own comments do it twice. Reading one as a config value seeded
  // the walk with the whole of lib/ — a green census that had stopped meaning
  // anything, found by asserting the seed count rather than trusting it.
  for (const m of src.matchAll(/["'](lib\/[^"']+)["']/g)) {
    const fixed = m[1].split("*")[0].replace(/\/$/, "");
    const abs = path.join(REPO, fixed);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory())
      for (const f of sourcesUnder(fixed)) seeds.add(f);
    else if (/\.(ts|tsx|mts|mjs)$/.test(fixed)) seeds.add(fixed);
  }
  return [...seeds];
}

/**
 * The specifiers a source file imports.
 *
 * Import and require FORMS only — these directories are cross-referenced in prose
 * comments all over the repo (a module naming the test that pins it), and treating
 * a mention as an import would fail on honest text while proving nothing.
 */
function importSpecifiers(src: string): string[] {
  return [
    ...src.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*["'`]([^"'`]+)["'`]/g
    ),
  ].map((m) => m[1]);
}

/**
 * The repo-relative path a specifier names, or null for a package.
 *
 * Existence is deliberately NOT required: a specifier naming a repo path is an
 * input to the tier whether or not it currently resolves, and a reach that does not
 * resolve is a mistake to surface rather than one to trust to stay broken.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith("."))
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), spec)
    );
  if (spec.startsWith("@/")) return spec.slice(2);
  return null;
}

/** The file a repo-relative specifier loads, trying the extensions vitest would. */
function resolveFileUncached(rel: string): string | null {
  const abs = path.join(REPO, rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel;
  for (const ext of [".ts", ".tsx", ".mts", ".mjs", ".js", ".json"]) {
    if (fs.existsSync(`${abs}${ext}`)) return `${rel}${ext}`;
    if (fs.existsSync(path.join(abs, `index${ext}`)))
      return path.posix.join(rel, `index${ext}`);
  }
  return null;
}

// The closure, coverage verdict and depth proof resolve the same immutable tree.
const resolvedFiles = new Map<string, string | null>();
function resolveFile(rel: string): string | null {
  const cached = resolvedFiles.get(rel);
  if (cached !== undefined) return cached;
  const resolved = resolveFileUncached(rel);
  resolvedFiles.set(rel, resolved);
  return resolved;
}

type SourceFile = { file: string; src: string };

const sourceTexts = new Map<string, string>();
function sourceText(file: string): string {
  let src = sourceTexts.get(file);
  if (src === undefined) {
    src = fs.readFileSync(path.join(REPO, file), "utf8");
    sourceTexts.set(file, src);
  }
  return src;
}

/** Reaches out of the trigger set, as `file → specifier`. */
function uncoveredIn(files: Iterable<SourceFile>, set: TriggerSet): string[] {
  const out: string[] = [];
  for (const { file, src } of files)
    for (const spec of importSpecifiers(src)) {
      const rel = resolveSpecifier(file, spec);
      if (!rel) continue;
      // Against the FILE where there is one: `@/middleware` is the single-file
      // entry `middleware.ts`, and a specifier is written without its extension.
      // An unresolvable path is still judged as written rather than excused.
      if (!covered(resolveFile(rel) ?? rel, set)) out.push(`${file} → ${spec}`);
    }
  return out;
}

let closure: string[] | null = null;

/** Every repo file the DB+action tier can load, transitively. */
function tierClosure(): string[] {
  if (closure) return closure;
  const seen = new Set<string>();
  const queue = seedFiles();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = sourceText(file);
    for (const spec of importSpecifiers(src)) {
      const rel = resolveSpecifier(file, spec);
      if (!rel) continue;
      const resolved = resolveFile(rel);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  closure = [...seen];
  return closure;
}

/** The closure with its text, read one file at a time rather than all at once. */
function* tierSources(): Generator<SourceFile> {
  for (const file of tierClosure()) yield { file, src: sourceText(file) };
}

describe("the test:db gate's trigger set", () => {
  it("is not vacuous — the gate script still declares one", () => {
    const set = triggerSet();
    expect(set.include).toContain("lib/");
    expect(set.include).toContain("app/");
    expect(set.include).toContain(DB_CONFIG);
    // And the gate really is conditional on it. An entry list nothing consults
    // would pass every assertion here while the gate ran unconditionally.
    const src = fs.readFileSync(path.join(REPO, GATES), "utf8");
    expect(src).toMatch(/paths_changed "\$\{db_tier_paths\[@\]\}"/);
    expect(src).toMatch(/GATE test:db: SKIPPED/);
  });

  it("covers every file the tier's import walk reaches", () => {
    expect(
      uncoveredIn(tierSources(), triggerSet()),
      "the DB+action tier imports a path `db_tier_paths` in " +
        `${GATES} does not cover, so a diff touching only that path would SKIP ` +
        "test:db while genuinely changing what it tests. Either add the path to " +
        "the array, or move the shared module somewhere the set already covers."
    ).toEqual([]);
    // The seeds are inputs too, and a config file is not reached by any import.
    expect(seedFiles().filter((f) => !covered(f))).toEqual([]);
  });

  it("seeds from the tier's RUN set, not from every path its config mentions", () => {
    // The census is only as good as where it starts, and over-seeding is the way it
    // goes quietly green: the first version of this scan read `lib/**` out of a
    // COMMENT in the coverage block, seeded all ~2,900 lib/ files, and then
    // "verified" the trigger set against the pure tier's imports as well — which
    // reach e2e/ and scripts/orchestration/ for honest reasons, and would have
    // argued for widening the set until the gate ran for everyone again.
    const seeds = seedFiles();
    expect(seeds.length).toBeGreaterThan(50);
    expect(seeds.length).toBeLessThan(sourcesUnder("lib").length / 2);
    // The pure tier is a DIFFERENT tier with a different config. If test:db ever
    // includes it, this is the assertion that says the trigger set must be re-asked.
    expect(seeds.filter((f) => f.startsWith("lib/__tests__/"))).toEqual([]);
  });

  it("still spares the diffs the conditional exists for", () => {
    // The other direction. Widening the set until it covers everything would pass
    // the census above and silently repeal #2954 — the gate would fire for a
    // docs-only agent again, which is the cost this change is about.
    for (const rel of [
      "docs/orchestration.md",
      "docs/internals/tracker-reconciliation.md",
      "e2e/smoke.spec.ts",
      ".github/workflows/ci.yml",
      ".claude/skills/file-issue/SKILL.md",
      "AGENTS.md",
      "README.md",
      GATES,
      "scripts/orchestration/dispatch-brief.mjs",
    ])
      expect(covered(rel), `${rel} must stay outside the trigger set`).toBe(
        false
      );
    // And the paths that must fire it, including the three the walk found outside
    // the obvious lib/+app/ guess.
    for (const rel of [
      "lib/db.ts",
      "app/(app)/training/video-actions.ts",
      "middleware.ts",
      "scripts/seed-personas.ts",
      "components/activity/ActivityMediaStrip.tsx",
    ])
      expect(covered(rel), `${rel} must fire the gate`).toBe(true);
  });

  it("walks transitively, not one hop", () => {
    const seeds = new Set(seedFiles());
    const closure = tierClosure();
    // A one-hop scan would find the tests and what they directly import. The tier's
    // real surface is an order of magnitude past that: lib/db.ts alone pulls every
    // migration module as a side effect.
    expect(closure.length).toBeGreaterThan(seeds.size * 2);
    expect(closure).toContain("lib/db.ts");
    // The reach that corrected the issue's guess, asserted so it stays a fact
    // rather than a memory: `lib/__db_tests__/auth.test.ts` imports and EXECUTES
    // the Next.js middleware, which is why a single root file is in the set.
    expect(closure).toContain("middleware.ts");
    // Non-vacuous in the direction that matters: something in the closure is
    // reachable ONLY through a chain, so dropping transitivity would lose it.
    const directlyImported = new Set<string>();
    for (const seed of seeds)
      for (const spec of importSpecifiers(sourceText(seed))) {
        const rel = resolveSpecifier(seed, spec);
        const resolved = rel && resolveFile(rel);
        if (resolved) directlyImported.add(resolved);
      }
    const deepOnly = closure.filter(
      (f) => !seeds.has(f) && !directlyImported.has(f)
    );
    expect(deepOnly.length).toBeGreaterThan(100);
  });
});

// The census above is only as good as what the matcher can SEE, and a green census
// is exactly what a blind matcher produces. So each reach below is one that would
// have to fail, run through the same `uncoveredIn` the real census uses (#2677).
describe("the trigger-set scan's reach", () => {
  const set = () => triggerSet();

  it("sees a reach out of the set in every spelling", () => {
    const reaches = [
      ["lib/__db_tests__/probe.test.ts", "../../docs/fixtures/sample"],
      ["lib/__db_tests__/probe.test.ts", "@/docs/fixtures/sample"],
      ["lib/queries/probe.ts", "../../e2e/support/factory"],
      ["app/(app)/probe/page.tsx", "../../../e2e/support/factory"],
      ["lib/probe.ts", "@/e2e/support/factory"],
      // The subtree the exclusion carves out of an otherwise-covered directory —
      // the mistake a plain `scripts/` prefix test would miss.
      ["lib/probe.ts", "@/scripts/orchestration/reconcile-tracker-core"],
      [
        "lib/queries/probe.ts",
        "../../scripts/orchestration/dispatch-brief.mjs",
      ],
    ] as const;
    for (const [file, spec] of reaches)
      expect(
        uncoveredIn([{ file, src: `import { x } from "${spec}";` }], set()),
        `${file} → ${spec}`
      ).toEqual([`${file} → ${spec}`]);
  });

  it("stays quiet on packages, covered paths, and honest comments", () => {
    // The other half of a matcher wide enough to be useful: it must not have become
    // a matcher for everything. Every line here is a real form the tier writes.
    const quiet = [
      'import fs from "node:fs";',
      'import { describe } from "vitest";',
      'import Database from "better-sqlite3";',
      'import { db } from "@/lib/db";',
      'import { helper } from "./setup-shared";',
      'import { PERSONAS } from "../../scripts/seed-personas";',
      'import { middleware } from "@/middleware";',
      'import type { View } from "@/components/activity/ActivityMediaStrip";',
      "// see docs/orchestration.md for the gate order",
      "/* the e2e/ suite covers this path end to end */",
    ];
    for (const src of quiet)
      expect(
        uncoveredIn([{ file: "lib/__db_tests__/probe.test.ts", src }], set()),
        src
      ).toEqual([]);
  });

  it("states what it CANNOT see", () => {
    // A guard credited with more than it does is worse than none. Two gaps, and no
    // text scan closes either.
    //
    // A specifier assembled at runtime: there is no literal to resolve.
    const computed =
      'const dir = "../../docs";\nawait import(`${dir}/fixtures/sample`);';
    expect(
      uncoveredIn(
        [{ file: "lib/__db_tests__/probe.test.ts", src: computed }],
        set()
      )
    ).toEqual([]);
    // And EXECUTION IS NOT IMPORT: a test shelling out to a script reaches it just
    // as surely, with no specifier to resolve. Naming the gap is the honest move; a
    // partial exec-detector would read like a total rule and be the failure this
    // family exists to prevent, one level down.
    const shelled =
      'execFileSync("bash", ["scripts/orchestration/agent-gates.sh"]);';
    expect(
      uncoveredIn(
        [{ file: "lib/__db_tests__/probe.test.ts", src: shelled }],
        set()
      )
    ).toEqual([]);
  });
});
