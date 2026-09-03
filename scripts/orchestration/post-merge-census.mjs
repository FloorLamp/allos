#!/usr/bin/env node
// Route a just-merged UI diff into the smallest census we can defend (#3489 D6).
//
// `UX_ROUTES` already scopes the pages journey. The missing part was deciding
// which prefixes a merge earned without quietly claiming import-graph coverage
// this repository does not have. App-owned files map by their first URL segment;
// shared components and shell files deliberately expand to the whole route set.
// Anything ambiguous fails instead of producing a reassuring empty census.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

const APP_ROOT = "app/(app)/";
const SHARED_APP_FILES = new Set([
  "app/globals.css",
  "app/global-error.tsx",
  "app/layout.tsx",
  "app/not-found.tsx",
  "app/(app)/error.tsx",
  "app/(app)/layout.tsx",
  "app/(app)/not-found.tsx",
]);
function fail(message) {
  throw new Error(message);
}

/** Enumerate the same route corpus as scripts/ux-walkthrough.mjs. */
export function enumerateCensusRoutes(repoRoot) {
  const appDir = path.join(repoRoot, "app", "(app)");
  if (!fs.existsSync(appDir)) fail(`missing census route root: ${appDir}`);

  const routes = [];
  function walk(dir, route) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${route}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        routes.push(route || "/");
      }
    }
  }
  walk(appDir, "");
  if (routes.length === 0) fail("the app route walk returned no census routes");
  return routes.sort();
}

/** Parse `git diff --name-status -z`; rename/copy records carry two paths. */
export function parseNameStatus(raw) {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) fail("git emitted an empty change status");
    const kind = status[0];
    if (!"ACDMRTUXB".includes(kind))
      fail(`unknown git change status: ${status}`);
    const pathCount = kind === "R" || kind === "C" ? 2 : 1;
    const paths = fields.slice(i, i + pathCount);
    if (paths.length !== pathCount || paths.some((file) => !file)) {
      fail(`incomplete git ${status} record`);
    }
    i += pathCount;
    changes.push({ status, paths });
  }
  return changes;
}

function isRoutePage(file) {
  return file.startsWith(APP_ROOT) && file.endsWith("/page.tsx");
}

function prefixHasRoute(prefix, routes) {
  return routes.some(
    (route) => route === prefix || route.startsWith(`${prefix}/`)
  );
}

function isKnownNonRuntime(file) {
  return (
    file.endsWith(".md") ||
    file.startsWith(".claude/") ||
    file.startsWith(".github/") ||
    file.startsWith("docs/") ||
    file.startsWith("e2e/") ||
    file.startsWith("lib/__db_tests__/") ||
    file.startsWith("lib/__tests__/") ||
    file.startsWith("scripts/orchestration/")
  );
}

/**
 * Turn changed paths into an honest census plan.
 *
 * No import graph is inferred. A shared component or shell file forces a full
 * run; an app territory is scoped only when that top-level URL prefix exists in
 * the current tree. Route deletion/rename is rejected because the current tree
 * cannot prove what the removed URL used to render.
 */
export function planPostMergeCensus(changes, routes) {
  if (changes.length === 0) fail("the ref range contains no changed files");
  if (routes.length === 0) fail("cannot plan a census over an empty route set");

  for (const change of changes) {
    const kind = change.status[0];
    if (
      (kind === "D" && change.paths.some(isRoutePage)) ||
      (kind === "R" && change.paths.some(isRoutePage))
    ) {
      fail(
        `route ${kind === "D" ? "deletion" : "rename"} needs a manual census plan: ${change.paths.join(" -> ")}`
      );
    }
  }

  const prefixes = new Set();
  const fullReasons = new Set();
  let mappedFiles = 0;

  for (const change of changes) {
    for (const file of change.paths) {
      if (file.startsWith("components/")) {
        mappedFiles++;
        fullReasons.add("shared components changed");
        continue;
      }
      if (SHARED_APP_FILES.has(file)) {
        mappedFiles++;
        fullReasons.add("shared app chrome changed");
        continue;
      }
      if (file === "app/(app)/page.tsx") {
        mappedFiles++;
        // The dashboard's own page: `/` is the only route it renders, so it
        // earns the same one-territory scope every other route page does. This
        // used to claim a FULL run, honestly — under prefix matching `/` selects
        // every route, so a home-only scope was not sayable. #4661 gave
        // UX_ROUTES an exact form, and `=/` is it.
        prefixes.add("=/");
        continue;
      }
      if (file.startsWith(APP_ROOT)) {
        mappedFiles++;
        const rest = file.slice(APP_ROOT.length);
        const slash = rest.indexOf("/");
        if (slash <= 0) {
          // Top-level files under the authenticated route group are shared by
          // convention (actions, gates, palette plumbing), not a URL territory.
          fullReasons.add("authenticated app-wide code changed");
          continue;
        }
        const segment = rest.slice(0, slash);
        if (segment.startsWith("(") || segment.startsWith("[")) {
          fail(`unknown app route shape: ${file}`);
        }
        const prefix = `/${segment}`;
        if (!prefixHasRoute(prefix, routes)) {
          fail(
            `changed app path maps to no current census route: ${file} -> ${prefix}`
          );
        }
        prefixes.add(prefix);
        continue;
      }
      if (file.startsWith("app/")) {
        fail(`unknown app path shape needs a manual census plan: ${file}`);
      }
      if (isKnownNonRuntime(file)) continue;

      // No import graph backs this mapping. A shared runtime file can reach any
      // surface, and ignoring it merely because another path supplied a prefix
      // turns a mixed diff into a false scoped claim.
      mappedFiles++;
      fullReasons.add("unmapped runtime/shared files changed");
    }
  }

  if (mappedFiles === 0) {
    fail("no changed file maps to a censused UI surface");
  }
  if (fullReasons.size > 0) {
    return {
      mode: "full",
      routes: [...routes],
      reasons: [...fullReasons].sort(),
      mappedFiles,
    };
  }
  if (prefixes.size === 0)
    fail("route mapping produced an empty scoped census");
  return {
    mode: "scoped",
    routes: [...prefixes].sort(),
    reasons: [],
    mappedFiles,
  };
}

function gitChanges(repoRoot, before, after) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", before, after, "--"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
  } catch {
    fail(`could not diff refs ${before}..${after}`);
  }
  return parseNameStatus(raw);
}

function usage() {
  return (
    "usage: node scripts/orchestration/post-merge-census.mjs <before-ref> [after-ref] [--run]\n" +
    "example: UX_SEED=1 node scripts/orchestration/post-merge-census.mjs HEAD^ HEAD --run"
  );
}

const PRESERVED_SHAPE_ENV = ["UX_SEED", "SEED_RNG", "SEED_PERSONA"];

function shellQuote(value) {
  if (/^[A-Za-z0-9_./,:=+-]+$/.test(value)) return value;
  if (value === "") return "''";
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function plannedCommand(plan, scope, env) {
  const assignments = [
    `UX_ROUTES=${shellQuote(plan.mode === "scoped" ? scope : "")}`,
  ];
  for (const name of PRESERVED_SHAPE_ENV) {
    if (env[name] !== undefined)
      assignments.push(`${name}=${shellQuote(env[name])}`);
  }
  return `${assignments.join(" ")} node scripts/ux-walkthrough.mjs --serve pages`;
}

function main(argv) {
  const run = argv.includes("--run");
  const refs = argv.filter((arg) => arg !== "--run");
  if (refs.length < 1 || refs.length > 2) fail(usage());
  const [before, after = "HEAD"] = refs;
  const repoRoot = process.cwd();
  const routes = enumerateCensusRoutes(repoRoot);
  const changes = gitChanges(repoRoot, before, after);
  const plan = planPostMergeCensus(changes, routes);

  const scope = plan.mode === "full" ? "all" : plan.routes.join(",");
  console.log(
    `post-merge census: ${plan.mode} (${scope}); ${plan.mappedFiles} mapped changed path(s)`
  );
  for (const reason of plan.reasons)
    console.log(`  full-run reason: ${reason}`);

  if (!run) {
    console.log(plannedCommand(plan, scope, process.env));
    return 0;
  }

  // `ux-walkthrough --serve` is the sole server/database lifecycle owner: it
  // claims a private scratch database, ignores a caller ALLOS_DB_PATH, and removes
  // the database plus sidecars during its own teardown. This wrapper only decides
  // which routes that harness should walk.
  const env = {
    ...process.env,
    UX_ROUTES: plan.mode === "scoped" ? scope : "",
  };
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
    { cwd: repoRoot, env, stdio: "inherit" }
  );
  if (result.error) fail(`could not start the census: ${result.error.message}`);
  return result.status ?? 1;
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const status = main(process.argv.slice(2));
    if (status !== 0) process.exitCode = status;
  } catch (error) {
    console.error(`post-merge census: ${error.message}`);
    process.exitCode = 2;
  }
}
