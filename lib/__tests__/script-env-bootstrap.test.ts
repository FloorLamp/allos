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
      return path.relative(ROOT, c);
  }
  return null;
}

function importSpecifiers(rel: string): string[] {
  const source = read(rel);
  const specs: string[] = [];
  const re =
    /(?:import|export)\b[^;'"]*?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1] || m[2]);
  return specs;
}

const reachesDbMemo = new Map<string, boolean>();
function reachesDb(rel: string, stack: Set<string> = new Set()): boolean {
  if (rel === DB_MODULE) return true;
  const cached = reachesDbMemo.get(rel);
  if (cached !== undefined) return cached;
  if (stack.has(rel)) return false; // break import cycles
  stack.add(rel);
  let result = false;
  for (const spec of importSpecifiers(rel)) {
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
// env-first obligation even when they touch process.env.
function isPlaywrightFile(rel: string): boolean {
  return (
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".setup.ts") ||
    read(rel).includes('"@playwright/test"')
  );
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
      out.push(path.relative(ROOT, full));
  }
  return out;
}

function discoverEntrypoints(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) files.push(...walk(abs));
  }
  return files
    .filter((rel) => rel !== ENV_LOADER && !isPlaywrightFile(rel))
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
      const expected = file.startsWith("e2e/")
        ? "../scripts/load-env"
        : "./load-env";

      expect(imports[0]).toBe(expected);
      expect(source).not.toContain('from "@next/env"');
      expect(source).not.toContain("loadEnvConfig(");
    }
  );

  it("keeps the actual Next env loader in the bootstrap dependency", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts/load-env.ts"),
      "utf8"
    );
    expect(source).toContain('from "@next/env"');
    expect(source).toContain("loadEnvConfig(process.cwd())");
  });
});
