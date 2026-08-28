import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import {
  BUILD_INPUT_DIRS,
  BUILD_INPUT_FILES,
  NON_BUILD_DIRS,
  writeBuildRecord,
} from "./build-inputs.mjs";
import { seedNextBuild } from "./build-seed.mjs";
import {
  RUN_LOCK_BASENAME,
  stopLeftoverWorkerServers,
} from "./global-teardown";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DB_BASENAME,
  E2E_DATA_DIR,
  E2E_DATA_ROOTS,
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
const BUILD_HEAP_MB = 4096;

// What invalidates the production build — the declaration lives in
// ./build-inputs.mjs because the worktree seeding step (#2605) asks a different
// question of the same set, and two copies of an invalidation rule is the shape
// that fails by serving a stale bundle rather than by throwing. e2e/** is
// deliberately absent from it: specs are not compiled into the app, so editing a
// spec must not trigger a rebuild.

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
    if (NON_BUILD_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
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
  // but fail loudly rather than boot workers against a missing build. The app both
  // paths serve is identical, so nothing ASSERTED differs between them (#2648).
  if (process.env.CI) {
    // ci-ok: build orchestration, not an assertion — who runs `npm run build` IS a genuine runner fact
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
  // A fresh agent worktree has no build at all, and compiling one costs ~200 s
  // before a single browser assertion runs (#2605). A sibling worktree branched
  // from the same commit usually has an identical one already; take it rather than
  // recompile it. Only ever when there is NO build here — a build this agent made
  // is never replaced — and only against proven-identical build inputs, never a
  // commit or an mtime. E2E_NO_SEED=1 opts out.
  if (!built && process.env.E2E_NO_SEED !== "1") {
    const seeded = seedNextBuild({ to: REPO_ROOT });
    if (seeded.seed) {
      console.log(
        `[e2e] seeded the production build from ${seeded.from} in ${seeded.ms}ms ` +
          `(proof: ${seeded.proof}) — no build needed (#2605)`
      );
      return;
    }
    // Refusals are named, never silent: they are the only signal that would show
    // this guard working, and a quiet fallback is indistinguishable from a bug.
    for (const attempt of seeded.attempts) {
      console.log(`[e2e] not seeding from ${attempt.from}: ${attempt.reason}`);
    }
  }
  console.log(
    built
      ? "[e2e] production build is stale — rebuilding (set E2E_SKIP_BUILD=1 to skip)"
      : "[e2e] no production build found — building (set E2E_SKIP_BUILD=1 to skip)"
  );
  // Next's compile plus TypeScript phase crosses V8's automatic ~2 GiB old-space
  // limit on the full app. Keep this direct bootstrap path aligned with the
  // repository's `npm run build` script: local Playwright runs deliberately build
  // without going through npm, so raising only package.json would leave this path
  // able to OOM before a single browser assertion runs.
  await run(
    process.execPath,
    [`--max-old-space-size=${BUILD_HEAP_MB}`, bin("next"), "build"],
    {
      cwd: REPO_ROOT,
      env: process.env,
      label: "next build",
    }
  );
  // Record WHAT this build was compiled from, beside the build (#2605). A fresh
  // agent worktree can then be handed this build instead of paying its own ~200 s
  // cold one, but only against a recorded fact — never an inference from mtimes,
  // which the copy destroys. Written only here, only after a build this process
  // just made, so the record can never describe a build it did not see.
  //
  // Advisory: a failure here costs the next worktree a cold build and nothing
  // else, and must not fail a suite that has already built successfully.
  try {
    const record = writeBuildRecord(REPO_ROOT, path.dirname(BUILD_ID));
    console.log(
      `[e2e] recorded ${record.fileCount} build inputs for seeding (#2605)`
    );
  } catch (err) {
    console.log(
      `[e2e] could not record build inputs (harmless): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
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

// ONE RUN OWNS ONE ROOT (#3921).
//
// A run's root is keyed on its port range (e2e/worker-env.ts), so two runs in one
// checkout on DIFFERENT ranges cannot reach each other's fixtures at all. Two on
// the SAME range never could coexist — they want the same listeners — and the
// failure they used to produce was the wrong shape: the second run wiped the
// first's seeded databases and auth state out from under it, so both runs' results
// were void INCLUDING their passes. So say it instead of doing it.
//
// The claim is the RUNNER process being alive, not the file existing: an
// interrupted run leaves a pid nobody is, which is not a claim. (`process.kill(pid,
// 0)` throwing is read as gone, the same reading e2e/fixtures.ts's slot reclaim
// makes.)
function runningRunnerIn(root: string): number | null {
  let pid: number;
  try {
    pid = Number(
      fs.readFileSync(path.join(root, RUN_LOCK_BASENAME), "utf8").trim()
    );
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Refuse a live sibling on this port range, then reset the root and claim it. */
export function claimRunRoot(root: string): void {
  const holder = runningRunnerIn(root);
  if (holder !== null) {
    throw new Error(
      `[e2e] another Playwright run (pid ${holder}) already owns ${root}.\n` +
        `Runs in one checkout are told apart by their PORT RANGE, so give this ` +
        `one its own: E2E_PORT=<base> npx playwright test … (#3921).\n` +
        `If that process is gone, delete ${path.join(root, RUN_LOCK_BASENAME)}.`
    );
  }
  // CLAIM BEFORE WIPING, and wipe the CONTENTS rather than the directory: the root
  // is then owned from the instant it exists, so a sibling starting on another
  // range cannot reclaim it in the window between the two calls. (Two runs
  // starting on the SAME range within the same microsecond can still both pass the
  // check above; making that impossible needs an atomic create that a stale lock
  // would then block on, which trades a microsecond race for a stuck harness.)
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, RUN_LOCK_BASENAME), String(process.pid));
  stopLeftoverWorkerServers(root);
  for (const entry of fs.readdirSync(root)) {
    if (entry === RUN_LOCK_BASENAME) continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

// WHAT THE PRE-#3921 LAYOUT PUT DIRECTLY UNDER `e2e/.data`, enumerated.
//
// Every checkout that ran the suite before the root moved keeps these, and
// nothing would ever come back for them: the sweep below only recognises
// `port-*`, and `git clean` leaves them because they are gitignored (it takes
// `-x`). They are multi-GB of SQLite on a disk-constrained box, so they are
// reclaimed once, here.
//
// ENUMERATED AND WHOLE-NAME, never a wider match, for the same reason
// lib/__tests__/tmp-dir.ts spells out its retired prefixes: this directory also
// holds THIS RUN'S OWN ROOT, and a predicate that reached one entry it did not
// mean would delete a live run's fixtures — the exact failure this whole change
// exists to end.
const LEGACY_FLAT_ENTRY =
  /^(?:template|template-demo|worker-\d+|slot-\d+\.pid|run-context\.json)$/;

/**
 * Drop the artifacts of runs that are over: the roots of finished runs on other
 * port ranges, so per-range roots don't accumulate one directory per port anybody
 * ever used, plus the flat layout that predates them. Only ever an UNCLAIMED root,
 * which is what makes this safe to do to a directory this run did not create; the
 * recorded servers are stopped first either way, because an orphan on another
 * range holds a real listener that nothing else would ever come back for.
 */
export function reclaimStaleRunRoots(parent: string, keep: string): string[] {
  const reclaimed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return reclaimed;
  }
  const legacy = entries.filter((entry) => LEGACY_FLAT_ENTRY.test(entry.name));
  if (legacy.length > 0) {
    // The old layout recorded its slot pids directly here, so this is where an
    // orphan of the last pre-move run is named.
    stopLeftoverWorkerServers(parent);
    for (const entry of legacy) {
      const target = path.join(parent, entry.name);
      fs.rmSync(target, { recursive: true, force: true });
      reclaimed.push(target);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^port-\d+$/.test(entry.name)) continue;
    const root = path.join(parent, entry.name);
    if (root === keep || runningRunnerIn(root) !== null) continue;
    stopLeftoverWorkerServers(root);
    fs.rmSync(root, { recursive: true, force: true });
    reclaimed.push(root);
  }
  return reclaimed;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const frozenNow = String(
    (config.metadata as { frozenNow?: string }).frozenNow ??
      process.env.ALLOS_TEST_NOW ??
      new Date().toISOString()
  );

  // Take this run's root, then wipe every artifact of a previous run in it: stale
  // worker dirs (a crashed run can leave one behind), the templates, and the run
  // context. Servers first — an interrupted run's orphan still holds a worker port,
  // and its pid record is about to be deleted with the directory.
  claimRunRoot(E2E_DATA_DIR);
  for (const stale of reclaimStaleRunRoots(E2E_DATA_ROOTS, E2E_DATA_DIR)) {
    console.log(`[e2e] reclaimed ${stale} — no live run owns it (#3921)`);
  }

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
