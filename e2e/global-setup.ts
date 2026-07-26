import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DB_BASENAME,
  E2E_DATA_DIR,
  RUN_CONTEXT_PATH,
  TEMPLATE_DEMO_DIR,
  TEMPLATE_DIR,
} from "./worker-env";

// Run-once setup for the DB-per-worker harness (issue #1538).
//
// This replaces the old `webServer` block, which did three jobs in one shell
// command (reset the DB, seed it, boot THE server). Now:
//
//   1. make sure a production build exists and is not stale (the per-worker
//      servers are `next start` — see e2e/fixtures.ts for why dev mode can't be
//      used per worker),
//   2. seed the TEMPLATE directories exactly once (the composed seed —
//      scripts/seed.ts then e2e/seed-events.ts, in that load-bearing order),
//   3. hand the run's frozen clock instant to the workers.
//
// Each worker then COPIES a template dir and boots its own server against it.
// Seeding is the expensive step (~20 s); copying is milliseconds.

const REPO_ROOT = process.cwd();
const BUILD_ID = path.join(REPO_ROOT, ".next", "BUILD_ID");

// Sources whose change invalidates the production build. e2e/** is deliberately
// absent: specs are not compiled into the app, so editing a spec must not trigger
// a rebuild.
const BUILD_INPUT_DIRS = ["app", "components", "lib", "public"];
const BUILD_INPUT_FILES = [
  "next.config.js",
  "middleware.ts",
  "package.json",
  "package-lock.json",
  "tailwind.config.ts",
  "postcss.config.js",
  "tsconfig.json",
];

function newestMtime(target: string, newest = 0): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return newest;
  }
  if (!stat.isDirectory()) return Math.max(newest, stat.mtimeMs);
  let best = newest;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    best = newestMtime(path.join(target, entry.name), best);
  }
  return best;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; label: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${opts.label} exited with code ${code}`))
    );
  });
}

function bin(name: string): string {
  return path.join(REPO_ROOT, "node_modules", ".bin", name);
}

/**
 * The per-worker servers run `next start`, so a build must exist. Local runs used
 * to use `next dev` (no build needed) — that is no longer possible per worker:
 * `next dev` takes a per-project single-instance lock and each worker would pay
 * its own on-demand compile of every route it touches. One shared production
 * build instead boots each worker in ~200 ms.
 *
 * Rebuild when the build is missing or older than any build input, so an agent who
 * edits a component and runs the suite is never served a stale bundle. Escape
 * hatches: E2E_SKIP_BUILD=1 (never build — CI, which builds in its own step),
 * E2E_FORCE_BUILD=1 (always build).
 */
async function ensureBuild(): Promise<void> {
  if (process.env.E2E_SKIP_BUILD === "1") return;
  // CI owns its own build step (.github/actions/e2e-setup) — never rebuild there,
  // but fail loudly rather than boot workers against a missing build.
  if (process.env.CI) {
    if (!fs.existsSync(BUILD_ID)) {
      throw new Error(
        "no production build found (.next/BUILD_ID) — CI must run `npm run build` before the e2e suite"
      );
    }
    return;
  }
  const built = fs.existsSync(BUILD_ID);
  let stale = !built;
  if (built && process.env.E2E_FORCE_BUILD !== "1") {
    const builtAt = fs.statSync(BUILD_ID).mtimeMs;
    let newest = 0;
    for (const dir of BUILD_INPUT_DIRS)
      newest = Math.max(newest, newestMtime(path.join(REPO_ROOT, dir)));
    for (const file of BUILD_INPUT_FILES)
      newest = Math.max(newest, newestMtime(path.join(REPO_ROOT, file)));
    stale = newest > builtAt;
  }
  if (process.env.E2E_FORCE_BUILD === "1") stale = true;
  if (!stale) return;
  console.log(
    built
      ? "[e2e] production build is stale — rebuilding (set E2E_SKIP_BUILD=1 to skip)"
      : "[e2e] no production build found — building (set E2E_SKIP_BUILD=1 to skip)"
  );
  await run(bin("next"), ["build"], {
    cwd: REPO_ROOT,
    env: process.env,
    label: "next build",
  });
}

/**
 * Seed one template directory. `demo` boots the seed with ALLOS_DEMO_MODE=1 (which
 * also creates the read-only demo login) and skips the e2e event layer, matching
 * what the old demo webServer did.
 */
async function seedTemplate(
  dir: string,
  frozenNow: string,
  demo: boolean
): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "data", "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data", "uploads"), { recursive: true });

  // CWD = the template dir, so every cwd-relative artifact the seed writes
  // (data/logs/errors.jsonl, uploads, integration payloads) lands INSIDE the
  // template and is copied to each worker with the DB.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ALLOS_DB_PATH: path.join(dir, DB_BASENAME),
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    ALLOS_TEST_NOW: frozenNow,
    ...(demo ? { ALLOS_DEMO_MODE: "1" } : {}),
  };
  const label = demo ? "demo template seed" : "template seed";
  await run(bin("tsx"), [path.join(REPO_ROOT, "scripts", "seed.ts")], {
    cwd: dir,
    env,
    label: `${label} (scripts/seed.ts)`,
  });
  if (!demo) {
    await run(bin("tsx"), [path.join(REPO_ROOT, "e2e", "seed-events.ts")], {
      cwd: dir,
      env,
      label: `${label} (e2e/seed-events.ts)`,
    });
  }
  // The seed process closed its connection, so SQLite has already checkpointed;
  // drop any sidecar anyway so a worker copies exactly one self-contained file.
  for (const suffix of ["-wal", "-shm", ".boot-lock"]) {
    fs.rmSync(path.join(dir, DB_BASENAME + suffix), { force: true });
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const frozenNow = String(
    (config.metadata as { frozenNow?: string }).frozenNow ??
      process.env.ALLOS_TEST_NOW ??
      new Date().toISOString()
  );

  // Wipe every artifact of a previous run: stale worker dirs (a crashed run can
  // leave one behind), the templates, and the run context.
  fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });

  await ensureBuild();

  const started = Date.now();
  await Promise.all([
    seedTemplate(TEMPLATE_DIR, frozenNow, false),
    seedTemplate(TEMPLATE_DEMO_DIR, frozenNow, true),
  ]);
  console.log(`[e2e] seeded worker templates in ${Date.now() - started}ms`);

  // The frozen instant must be identical in the template seed and in every worker
  // server (a date-derived assertion compares seeded rows against the app's
  // "today"). Workers are separate processes, so it is handed over on disk.
  fs.writeFileSync(
    RUN_CONTEXT_PATH,
    JSON.stringify({ frozenNow }, null, 2) + "\n"
  );
}
