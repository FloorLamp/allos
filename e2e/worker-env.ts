import path from "node:path";

// DB-per-worker addressing (issue #1538) — the ONE place that answers "which DB,
// which port, which directory belongs to THIS Playwright worker".
//
// The suite used to boot ONE app server against ONE seeded SQLite DB and run every
// worker against it, so `--workers=N` fabricated failures (two specs writing the
// same rows at the same time) and the suite was pinned to `--workers=1`. Now each
// worker gets its OWN copy of the seeded template DB and its OWN `next start`
// server (the app holds a singleton better-sqlite3 handle opened at boot from
// ALLOS_DB_PATH — one server is exactly one DB for life, so DB-per-worker
// NECESSARILY means server-per-worker). See docs/internals/e2e-hygiene.md.
//
// Everything here keys on Playwright's TEST_PARALLEL_INDEX, which the worker
// process sets on itself BEFORE it loads any test file (playwright's
// workerProcessEntry) — so a spec's module-level `const DB = workerDbPath()`
// already resolves to that worker's DB. In the main process (the config,
// global-setup) the variable is unset and these resolve to worker 0's slot; only
// the template/data-root paths are read there.

// Playwright is always invoked from the repo root (playwright.config.ts lives
// there and the suite's file fixtures have always been cwd-relative).
const REPO_ROOT = process.cwd();

/** Root for every throwaway e2e artifact — gitignored. */
export const E2E_DATA_DIR = path.join(REPO_ROOT, "e2e", ".data");

/**
 * The seeded TEMPLATE directories, built once per run by global-setup.ts and then
 * directory-copied per worker (copying a seeded SQLite file is milliseconds;
 * re-running the composed seed per worker would cost ~20 s each).
 *
 * A template is a DIRECTORY, not just a `.db`, because the seed also writes
 * cwd-relative artifacts the app later reads — `data/logs/errors.jsonl` (the
 * Settings → Errors fixture), `data/uploads/**`, `data/integration-payloads/**`.
 * The seed runs WITH THE TEMPLATE DIR AS ITS CWD, so those land inside the
 * template and travel with the copy.
 */
export const TEMPLATE_DIR = path.join(E2E_DATA_DIR, "template");
export const TEMPLATE_DEMO_DIR = path.join(E2E_DATA_DIR, "template-demo");

/** The database file inside a template dir / a worker dir. */
export const DB_BASENAME = "app.db";

/** Where global-setup.ts hands the run-wide frozen clock to the workers. */
export const RUN_CONTEXT_PATH = path.join(E2E_DATA_DIR, "run-context.json");

/**
 * Base port for the per-worker servers; worker N listens on BASE + N. Overridable
 * (E2E_PORT) so a sandboxed environment can move the whole range at once.
 */
export const PORT_BASE = Number(process.env.E2E_PORT ?? 3100);

/** Admin credentials the seed bootstraps, and that each worker logs in with. */
export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "e2e-admin-pass";

/** This Playwright worker's parallel index (0 in the main process). */
export function workerIndex(): number {
  return Number(process.env.TEST_PARALLEL_INDEX ?? 0);
}

/**
 * This worker's private directory. It is also the app server's CWD, which is what
 * isolates every cwd-relative runtime artifact the app writes — `data/uploads/**`,
 * `data/logs/ai.jsonl`, `data/logs/errors.jsonl`, `data/backups/**` — per worker.
 * (The server is started as `next start <repoRoot>`, so the build is shared while
 * the working directory is not.)
 */
export function workerDir(idx: number = workerIndex()): string {
  return path.join(E2E_DATA_DIR, `worker-${idx}`);
}

/**
 * This worker's database. Specs that read/write the DB directly MUST use this —
 * never `process.env.ALLOS_DB_PATH` (the hygiene guard fails a new direct read),
 * which is a property of the app server's environment, not of the spec process.
 */
export function workerDbPath(idx: number = workerIndex()): string {
  return path.join(workerDir(idx), DB_BASENAME);
}

/** This worker's captured outbound mailbox (lib/email's EMAIL_TEST_CAPTURE sink). */
export function workerMailboxPath(idx: number = workerIndex()): string {
  return path.join(workerDir(idx), "mailbox.jsonl");
}

/** This worker's saved storage state (its own logged-in admin session). */
export function workerAuthPath(idx: number = workerIndex()): string {
  return path.join(workerDir(idx), "auth.json");
}

export function workerPort(idx: number = workerIndex()): number {
  return PORT_BASE + idx;
}

export function workerBaseURL(idx: number = workerIndex()): string {
  return `http://localhost:${workerPort(idx)}`;
}
