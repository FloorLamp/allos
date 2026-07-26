import fs from "node:fs";
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
// Everything here keys on the two indices Playwright's worker process sets on
// ITSELF before it loads any test file (playwright's workerProcessEntry), so a
// spec's module-level `const DB = workerDbPath()` already resolves correctly:
//
//   • TEST_WORKER_INDEX   — unique per worker PROCESS for the whole run. It names
//     the worker's DIRECTORY (database, uploads, logs, storage state). Playwright
//     retires a worker after a failed test and starts a REPLACEMENT for the same
//     slot, and the two overlap: the replacement sets up while its predecessor is
//     still finishing teardown. Keying the directory on the process index means a
//     replacement never wipes a directory another process is still serving from.
//   • TEST_PARALLEL_INDEX — the SLOT (0..workers-1), which names the PORT. Ports
//     have to be a small bounded range, so the slot's port genuinely is reused by
//     the replacement — that is the one thing handed over, and e2e/fixtures.ts
//     reclaims it explicitly (kill the recorded pid, wait for the listener).
//
// In the main process (the config, global-setup) both are unset and these resolve
// to slot/worker 0; only the template and data-root paths are read there.

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
 * THE run's frozen instant — the one `now()` the seeded template, every worker's
 * app server and (via e2e/fixtures.ts) every browser context share.
 *
 * A SPEC'S "NOW" IS THIS, NEVER THE WALL CLOCK. The gap between the frozen instant
 * and real time is the elapsed length of the run, which used to be a few minutes
 * and is now up to ~90 minutes on a repeat-each lane — long enough that a row
 * written from real time lands in the app's FUTURE and drops out of every recency
 * window (the #1441 finished-session recap was the first to fail this way,
 * deterministically, 29 minutes into a lane). So a spec that computes a timestamp
 * derives it from here.
 *
 * Cached: the file is written once, before any worker starts.
 */
let frozenNowCache: Date | undefined;
export function frozenNow(): Date {
  if (frozenNowCache) return new Date(frozenNowCache);
  let iso = process.env.ALLOS_TEST_NOW;
  try {
    const raw = JSON.parse(fs.readFileSync(RUN_CONTEXT_PATH, "utf8")) as {
      frozenNow?: string;
    };
    if (raw.frozenNow) iso = raw.frozenNow;
  } catch {
    // Not written yet (the main process before global-setup) — fall back below.
  }
  frozenNowCache = iso ? new Date(iso) : new Date();
  return new Date(frozenNowCache);
}

/**
 * The frozen instant as `HH:MM` in `zone` — the value the app's own client-side
 * "now" shortcuts prefill a time field with, computed from the FROZEN clock so a
 * spec can back-date from it without reading the browser's wall clock.
 */
export function frozenLocalHHMM(zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(frozenNow());
}

/**
 * Base port for the per-worker servers; worker N listens on BASE + N. Overridable
 * (E2E_PORT) so a sandboxed environment can move the whole range at once.
 */
export const PORT_BASE = Number(process.env.E2E_PORT ?? 3100);

/** Admin credentials the seed bootstraps, and that each worker logs in with. */
export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "e2e-admin-pass";

/** This worker PROCESS's index — unique for the whole run (0 in the main process). */
export function workerIndex(): number {
  return Number(process.env.TEST_WORKER_INDEX ?? 0);
}

/** This worker's SLOT (0..workers-1) — what the port is keyed on. */
export function slotIndex(): number {
  return Number(process.env.TEST_PARALLEL_INDEX ?? 0);
}

/**
 * This worker PROCESS's private directory. It is also the app server's CWD, which
 * is what isolates every cwd-relative runtime artifact the app writes — `data/uploads/**`,
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

export function workerPort(slot: number = slotIndex()): number {
  return PORT_BASE + slot;
}

/**
 * Where a slot records the pid of the server currently holding its port. It lives
 * OUTSIDE any worker directory precisely because it is handed from one worker
 * process to the next.
 */
export function slotPidPath(slot: number = slotIndex()): string {
  return path.join(E2E_DATA_DIR, `slot-${slot}.pid`);
}

export function workerBaseURL(slot: number = slotIndex()): string {
  return `http://localhost:${workerPort(slot)}`;
}
