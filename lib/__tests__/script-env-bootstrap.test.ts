// SOURCE-SCAN tier — standalone tsx scripts must load Next's env files before
// evaluating any dependency that can reach lib/db.ts. An inline loadEnvConfig()
// call is insufficient: ESM evaluates every static dependency before running the
// entrypoint body, which caused `npm run seed` to bootstrap a random admin password
// even when ADMIN_PASSWORD was present in .env.
//
// The entrypoint list is DERIVED, not hardcoded (issue #696): a static enumeration
// silently stopped covering any NEW standalone script that started touching
// process.env / lib/db. Instead we scan scripts/ and e2e/ for the files that are
// standalone tsx ENTRYPOINTS (run directly via tsx/node, not by the Playwright
// runner which loads env itself) AND that reach the env-sensitive boot surface —
// either by TRANSITIVELY importing lib/db (the #679 password-bootstrap bug class)
// or by reading process.env directly (they need the same .env values loaded first).
// Every such file must import the env loader before anything else.
//
// "Transitively imports" means AT RUNTIME. Type-only edges are erased by the compiler
// and are not followed — see runtimeImportSpecifiers.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DB_MODULE = "lib/db.ts";
const ENV_LOADER = "scripts/load-env.ts";
const SCAN_DIRS = ["scripts", "e2e"];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// Resolve a relative (`./`, `../`) or `@/`-aliased import specifier to a repo-
// relative source file, mirroring tsconfig's `@/*` → repo-root mapping. Returns
// null for bare package specifiers (node_modules) — they can't reach lib/db.
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../"))
    base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
  else return null;
  const candidates = [
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    base,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile())
      return path.relative(ROOT, c).split(path.sep).join("/");
  }
  return null;
}

// Extract the module specifiers a source file names. `runtimeOnly` drops the edges
// that are ERASED at compile time — see runtimeImportSpecifiers below for why the
// reachability traversal must not count them.
function specifiersIn(source: string, runtimeOnly: boolean): string[] {
  const specs: string[] = [];
  // Group 1 is whatever sits between the keyword and the specifier's opening quote
  // ("`type { A } from `", "` { type A, B } from `", "`(`" for a dynamic import), which
  // is what lets a whole-statement type import be told apart from a value one.
  const re =
    /(?:import|export)\b([^;'"]*?)["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (runtimeOnly && m[1] !== undefined && /^\s*type\b/.test(m[1])) continue;
    specs.push(m[2] || m[3]);
  }
  return specs;
}

function importSpecifiers(rel: string): string[] {
  return specifiersIn(read(rel), false);
}

// THE EDGES THAT SURVIVE TO RUNTIME — the only ones `reachesDb` may follow.
//
// This guard exists for the #679 class: a standalone script pulling lib/db INTO THE
// PROCESS before .env is loaded. That is a claim about what the module loader actually
// evaluates, so an edge that does not exist at runtime cannot cause it. `import type` /
// `export type` statements are erased wholesale by the compiler, so they name a
// dependency that is never fetched, never evaluated, and can never bootstrap a database.
//
// Counting them was a real false positive, not a hypothetical one: a pure curated
// data generator was reclassified as env-sensitive because a types barrel it imports
// TYPES from happened to re-export a type declared beside a registry that mentions
// lib/settings in a type position. Three erased edges, one imaginary path to lib/db, and
// the fix the failure suggests — adding ./load-env to the generator — would have made
// the script assert something untrue about itself to quiet a scan.
//
// ONLY THE WHOLE-STATEMENT FORM IS DROPPED. `import { type X, Y } from "z"` keeps
// counting: `Y` is a value, the module is fetched and evaluated, and the edge is as real
// as any other. A statement whose bindings are individually all types is also elided by
// the compiler, but deciding that needs per-binding analysis rather than a regex — so
// this errs toward COUNTING, which is the safe direction for a guard: a false positive
// costs a conversation, a false negative costs the bug this file exists to prevent.
function runtimeImportSpecifiers(rel: string): string[] {
  return specifiersIn(read(rel), true);
}

const reachesDbMemo = new Map<string, boolean>();
function reachesDb(rel: string, stack: Set<string> = new Set()): boolean {
  if (rel === DB_MODULE) return true;
  const cached = reachesDbMemo.get(rel);
  if (cached !== undefined) return cached;
  if (stack.has(rel)) return false; // break import cycles
  stack.add(rel);
  let result = false;
  for (const spec of runtimeImportSpecifiers(rel)) {
    const target = resolveImport(rel, spec);
    if (target && (target === DB_MODULE || reachesDb(target, stack))) {
      result = true;
      break;
    }
  }
  stack.delete(rel);
  reachesDbMemo.set(rel, result);
  return result;
}

// Playwright test/spec/setup files are run by the Playwright runner (which loads
// env via playwright.config.ts), NOT as standalone tsx entrypoints, so they own no
// env-first obligation even when they touch process.env. The same is true of the
// harness modules those files IMPORT (e2e/worker-env.ts, the DB-per-worker
// addressing module of #1538): they are only ever evaluated inside a Playwright
// process, so the closure below excludes them too. A module reached from
// e2e/seed-events.ts (a real standalone tsx entrypoint that does NOT import
// @playwright/test) is not in this closure and stays covered.
function isPlaywrightSource(rel: string): boolean {
  return (
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".setup.ts") ||
    read(rel).includes('"@playwright/test"')
  );
}

// The Playwright config is the other runner entrypoint: whatever it names
// (globalSetup, globalTeardown) and whatever those import is loaded by the runner,
// never by `tsx`.
const PLAYWRIGHT_CONFIG = "playwright.config.ts";

function importClosure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of importSpecifiers(rel)) {
      const target = resolveImport(rel, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

const { playwrightOnly } = (() => {
  const all: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) all.push(...walk(abs));
  }
  const fromPlaywright = importClosure([
    PLAYWRIGHT_CONFIG,
    ...all.filter(isPlaywrightSource),
  ]);
  // Anything a NON-Playwright module IMPORTS can end up evaluated by a standalone
  // `tsx` run (e2e/seed/* under e2e/seed-events.ts, for instance), so it keeps its
  // env-first obligation even when a spec also imports it. Seeded from those
  // modules' import TARGETS rather than the modules themselves, so a file's own
  // presence in scripts//e2e/ never exempts it — only being loaded exclusively by
  // the Playwright runner does.
  const standaloneSeeds = all
    .filter((f) => !fromPlaywright.has(f))
    .flatMap((f) =>
      importSpecifiers(f)
        .map((spec) => resolveImport(f, spec))
        .filter((t): t is string => t !== null)
    );
  const fromStandalone = importClosure(standaloneSeeds);
  return {
    playwrightOnly: new Set(
      [...fromPlaywright].filter((f) => !fromStandalone.has(f))
    ),
  };
})();

function isPlaywrightFile(rel: string): boolean {
  return playwrightOnly.has(rel);
}

function usesProcessEnv(rel: string): boolean {
  return /\bprocess\.env\b/.test(read(rel));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

// Standalone entrypoints that read process.env but must NOT load this repo's .env files.
// Keep this SHORT and justified: the default is that a script touching process.env owes
// the env-first import, and an entry here is a claim that loading .env would be WRONG for
// that script, not merely unnecessary.
const ENV_FREE = new Set<string>([
  // scripts/upload-docs.ts (#1735) — the remote document-upload CLI. It is deliberately
  // DEPENDENCY-FREE (Node stdlib only, nothing from this repo) so it can be copied to any
  // machine with Node 24 and run against a remote instance with no checkout, no database
  // and no version-skew concern. Importing ./load-env would pull in @next/env and destroy
  // exactly that property. Its two variables (ALLOS_TOKEN, ALLOS_URL) are supplied by the
  // OPERATOR'S shell on the REMOTE machine — this repo's .env belongs to the server, not
  // to the client, and reading it would be the wrong behaviour rather than a missing one.
  // It cannot reach lib/db (the #679 bug class this guard exists for) because it imports
  // nothing from the repo at all.
  "scripts/upload-docs.ts",
]);

function discoverEntrypoints(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) files.push(...walk(abs));
  }
  return files
    .filter(
      (rel) =>
        rel !== ENV_LOADER && !isPlaywrightFile(rel) && !ENV_FREE.has(rel)
    )
    .filter((rel) => reachesDb(rel) || usesProcessEnv(rel))
    .sort();
}

const ENTRYPOINTS = discoverEntrypoints();

function staticImports(source: string): string[] {
  return [
    ...source.matchAll(/^import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["'];/gm),
  ].map((match) => match[1]);
}

describe("standalone script environment bootstrap", () => {
  it("discovers at least the known env-sensitive entrypoints", () => {
    // A sanity floor so a broken scan (e.g. a regex regression) that finds nothing
    // can't make the per-file assertions vacuously pass.
    expect(ENTRYPOINTS).toEqual(
      expect.arrayContaining(["scripts/seed.ts", "scripts/notify.ts"])
    );
  });

  it.each(ENTRYPOINTS)(
    "loads env before every other dependency: %s",
    (file) => {
      const source = read(file);
      const imports = staticImports(source);
      // The specifier is depth-relative: scripts/*.ts reach the loader as
      // "./load-env", e2e/*.ts as "../scripts/load-env", and a NESTED module
      // (e2e/seed/*.ts, the #1511 per-domain split) as "../../scripts/load-env".
      // Computed rather than hardcoded so a new subdirectory keeps being checked
      // instead of silently failing on the wrong expected string.
      const rel = path
        .relative(path.dirname(file), ENV_LOADER.replace(/\.ts$/, ""))
        .replace(/\\/g, "/");
      const expected = rel.startsWith(".") ? rel : `./${rel}`;

      expect(imports[0]).toBe(expected);
      expect(source).not.toContain('from "@next/env"');
      expect(source).not.toContain("loadEnvConfig(");
    }
  );

  it.each([...ENV_FREE])(
    "an env-free entrypoint really imports nothing from this repo: %s",
    (file) => {
      // The exemption above is only honest while the script stays dependency-free. If it
      // ever grows a repo import, it can reach lib/db and must rejoin the guard.
      const targets = importSpecifiers(file)
        .map((spec) => resolveImport(file, spec))
        .filter((t): t is string => t !== null);
      expect(targets).toEqual([]);
      expect(reachesDb(file)).toBe(false);
    }
  );

  // THE ERASED-EDGE FIXTURE. Both directions, because getting either wrong breaks the
  // guard in a different way: counting an erased edge invents entrypoints (and invites
  // silencing the scan by adding ./load-env to a script that does not need it), while
  // dropping a real one lets the #679 bug class back through unnoticed.
  describe("the reachability traversal follows runtime edges only", () => {
    const ERASED = [
      ['import type { A } from "./x";', "a type-only named import"],
      ['import type A from "./x";', "a type-only default import"],
      ['import type * as A from "./x";', "a type-only namespace import"],
      ['export type { A } from "./x";', "a type-only re-export"],
      ['import type {A} from "./x";', "no space before the brace"],
    ] as const;

    const REAL = [
      ['import { type A, B } from "./x";', "a MIXED import — B is a value"],
      ['import { A } from "./x";', "an ordinary named import"],
      ['import A from "./x";', "a default import"],
      ['import * as A from "./x";', "a namespace import"],
      ['import "./x";', "a side-effect import"],
      ['export { A } from "./x";', "a value re-export"],
      ['const m = await import("./x");', "a dynamic import"],
      ['import typeName from "./x";', "a default binding merely NAMED type…"],
      ['import { typeName } from "./x";', "…and the named form of the same"],
    ] as const;

    it.each(ERASED)("erases %s (%s)", (source) => {
      expect(specifiersIn(source, true)).toEqual([]);
      // Still visible to the callers that want every declared dependency.
      expect(specifiersIn(source, false)).toEqual(["./x"]);
    });

    it.each(REAL)("keeps %s (%s)", (source) => {
      expect(specifiersIn(source, true)).toEqual(["./x"]);
    });

    // END TO END, on real modules, so the fixture above can't drift from the traversal.
    it("does not make a file an entrypoint through an erased edge", () => {
      // lib/recap-scale.ts reaches lib/settings ONLY as `import type { WeekMode,
      // WeekStart }` (#2178). Before this fix that erased edge walked on to
      // lib/settings/kv.ts → lib/db.ts and dragged a pure dataset generator three
      // modules away into the entrypoint set.
      expect(read("lib/recap-scale.ts")).toContain(
        'import type { WeekMode, WeekStart } from "./settings"'
      );
      expect(reachesDb("lib/recap-scale.ts")).toBe(false);
    });

    it("still follows a real value edge all the way to lib/db", () => {
      expect(reachesDb("lib/settings.ts")).toBe(true);
    });
  });

  it("keeps the actual Next env loader in the bootstrap dependency", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts/load-env.ts"),
      "utf8"
    );
    expect(source).toContain('from "@next/env"');
    expect(source).toContain("loadEnvConfig(process.cwd())");
  });
});
