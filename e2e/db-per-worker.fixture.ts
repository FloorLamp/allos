import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

// ─────────────────────────────────────────────────────────────────────────────
// SPIKE (reversible POC): DB-per-worker (server-per-worker) e2e isolation.
//
// The default harness (playwright.config.ts) boots ONE app server bound to ONE
// seeded SQLite DB via ALLOS_DB_PATH, and every worker shares it — the root flake
// source (docs/internals/e2e-hygiene.md): specs can see each other's writes. Since
// the app holds a SINGLETON better-sqlite3 connection opened at boot (lib/db.ts),
// one server = exactly one DB for life, so DB-per-worker NECESSARILY means
// SERVER-per-worker.
//
// This worker-scoped fixture, keyed on testInfo.parallelIndex, gives each Playwright
// worker its OWN throwaway DB + its OWN `next start` server + its OWN admin session,
// so nothing is shared. It is wired ONLY into playwright.db-per-worker.config.ts over
// a handful of representative specs; the main config is untouched.
//
// The crux is per-worker AUTH: the shared e2e/.auth/state.json cookie is a row in
// ONE DB's `sessions` table, invalid against any other DB. So authentication moves
// INTO this fixture — each worker logs in against ITS server and produces its own
// per-worker storageState, which we hand to the built-in `context`/`page` fixtures
// by overriding the `storageState` option below.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
const DATA_DIR = path.join(REPO_ROOT, "e2e", ".data");
// Base port well clear of the main config's 3100/3101 so a stray shared-config
// server can't collide with a worker server.
const BASE_PORT = 3200;

// Freeze the clock for this worker process, mirroring playwright.config.ts. Computed
// ONCE per worker at module load, so this worker's seed scripts AND its app server
// share the same instant (date-derived specs — Today bands, workout presence — depend
// on seed and app agreeing). Each worker process computes its own value; that is fine
// because agreement only has to hold WITHIN a worker's own DB+server pair.
const FROZEN_NOW = process.env.ALLOS_TEST_NOW ?? new Date().toISOString();

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "e2e-admin-pass";

export interface WorkerServer {
  baseURL: string;
  port: number;
  dbPath: string;
  storageStatePath: string;
}

// Resolve a node_modules/.bin executable (next, tsx). node_modules is symlinked into
// the worktree, so the bin shims resolve from the repo root.
function bin(name: string): string {
  return path.join(REPO_ROOT, "node_modules", ".bin", name);
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${path.basename(cmd)} ${args.join(" ")} exited ${code}`)
          )
    );
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      // /login renders 200; any HTTP answer means the server is accepting requests.
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `server at ${url} not ready within ${timeoutMs}ms: ${String(lastErr)}`
  );
}

function freePortCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

type WorkerFixtures = {
  workerServer: WorkerServer;
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  workerServer: [
    async ({ browser }, use, workerInfo) => {
      const idx = workerInfo.parallelIndex;
      const port = BASE_PORT + idx;
      const dbPath = path.join(DATA_DIR, `worker-${idx}.db`);
      const storageStatePath = path.join(DATA_DIR, `worker-${idx}-auth.json`);
      const baseURL = `http://localhost:${port}`;

      fs.mkdirSync(DATA_DIR, { recursive: true });
      // Fresh DB per worker: wipe the file + WAL/SHM sidecars.
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(dbPath + suffix, { force: true });

      const started = Date.now();

      // The worker's own env: its DB, the frozen clock, and the admin creds the seed
      // bootstraps. NODE_ENV=production for a CI-equivalent `next start`.
      const workerEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ALLOS_DB_PATH: dbPath,
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
        ALLOS_TEST_NOW: FROZEN_NOW,
        NODE_ENV: "production",
      };

      // 1) Seed this worker's DB (the same two scripts the main webServer runs).
      const seedStart = Date.now();
      await run(bin("tsx"), ["scripts/seed.ts"], workerEnv);
      await run(bin("tsx"), ["e2e/seed-events.ts"], workerEnv);
      const seedMs = Date.now() - seedStart;

      if (!(await freePortCheck(port))) {
        throw new Error(
          `port ${port} for worker ${idx} is already in use — is another server running?`
        );
      }

      // 2) Boot this worker's app server (CI-equivalent production start).
      const bootStart = Date.now();
      const server: ChildProcess = spawn(
        bin("next"),
        ["start", "-p", String(port)],
        { cwd: REPO_ROOT, env: workerEnv, stdio: "inherit" }
      );
      let serverExited: number | null = null;
      server.on("exit", (code) => {
        serverExited = code ?? -1;
      });

      await waitForHttp(`${baseURL}/login`, 120_000);
      if (serverExited !== null) {
        throw new Error(`worker ${idx} server exited early (${serverExited})`);
      }
      const bootMs = Date.now() - bootStart;

      // 3) Per-worker AUTH (the crux). Log in as admin against THIS server in a
      //    throwaway context and persist the resulting session cookie as this
      //    worker's storageState — invalid against any other worker's DB, valid
      //    against this one.
      const authStart = Date.now();
      const authCtx = await browser.newContext({ baseURL });
      const authPage = await authCtx.newPage();
      await authPage.goto("/login");
      await authPage.fill('input[name="username"]', ADMIN_USERNAME);
      await authPage.fill('input[name="password"]', ADMIN_PASSWORD);
      await authPage.click('button[type="submit"]');
      await authPage.waitForURL((u) => !u.pathname.startsWith("/login"), {
        timeout: 30_000,
      });
      await authCtx.storageState({ path: storageStatePath });
      await authCtx.close();
      const authMs = Date.now() - authStart;

      // Make the worker DB path visible to specs that open the DB directly (e.g.
      // smoke's resetCoachingSnooze reads process.env.ALLOS_DB_PATH). Workers are
      // SEPARATE processes, so this env write is worker-local and safe.
      process.env.ALLOS_DB_PATH = dbPath;

      const totalMs = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(
        `[db-per-worker] worker ${idx}: port=${port} db=${dbPath} ` +
          `seed=${seedMs}ms boot=${bootMs}ms auth=${authMs}ms total=${totalMs}ms`
      );

      await use({ baseURL, port, dbPath, storageStatePath });

      // ── Teardown: kill the server, delete the DB + auth state ──
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null || serverExited !== null) return resolve();
        server.once("exit", () => resolve());
        server.kill("SIGTERM");
        // Hard-kill backstop if it ignores SIGTERM.
        setTimeout(() => {
          if (server.exitCode === null) server.kill("SIGKILL");
        }, 4000);
      });
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(dbPath + suffix, { force: true });
      fs.rmSync(storageStatePath, { force: true });
    },
    { scope: "worker" },
  ],

  // Override the test-scoped baseURL so page/context — AND manual browser.newContext()
  // calls in helpers (loginAs) — target THIS worker's server. (`use` here is the
  // Playwright fixture setup callback, not a React hook — the rules-of-hooks lint
  // rule mis-fires on the name.)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  baseURL: async ({ workerServer }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerServer.baseURL);
  },

  // Override storageState so the built-in `context`/`page` start authenticated against
  // THIS worker's DB (the per-worker replacement for the shared e2e/.auth/state.json).
  // eslint-disable-next-line react-hooks/rules-of-hooks
  storageState: async ({ workerServer }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerServer.storageStatePath);
  },
});

export { expect };
