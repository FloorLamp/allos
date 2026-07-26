import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  frozenNow,
  RUN_CONTEXT_PATH,
  slotPidPath,
  TEMPLATE_DEMO_DIR,
  TEMPLATE_DIR,
  workerAuthPath,
  workerBaseURL,
  workerDbPath,
  workerDir,
  workerMailboxPath,
  workerPort,
} from "./worker-env";

// DB-per-worker isolation (issue #1538). EVERY spec imports `test`/`expect` from
// here instead of "@playwright/test" — that import is what gives the spec its
// worker's own server + own database.
//
// WHY server-per-worker. The app opens ONE better-sqlite3 handle at boot from
// ALLOS_DB_PATH and keeps it for the process lifetime (lib/db.ts), so one server
// is exactly one database — a per-request DB switch would mean rewriting the
// product's connection singleton. DB-per-worker therefore means server-per-worker.
// The cost is one `next start` per worker (~200 ms boot, ~190 MB RSS) against ONE
// shared production build; the payoff is that `--workers=N` stops fabricating
// failures, because no two workers can see each other's writes.
//
// WHAT EACH WORKER GETS (all under e2e/.data/worker-<workerIndex>/):
//   • app.db      — a COPY of the template seeded once by e2e/global-setup.ts
//   • data/**     — the server runs with this dir as its CWD, so uploads, the AI
//                   log, the error log and integration payloads are per-worker too
//   • auth.json   — its own logged-in admin session (a session row lives in ITS
//                   database, so the old single shared e2e/.auth/state.json could
//                   not possibly work here)
//   • server.log  — that worker's server output, kept after the run for postmortem
//
// The `baseURL` and `storageState` overrides below are what make this transparent:
// the built-in `page`/`context` fixtures — and any manual `browser.newContext()`,
// which inherits the test's resolved options — target THIS worker's server, already
// signed in. Specs keep using relative `page.goto("/nutrition")` as before.
//
// Specs that talk to SQLite directly use `workerDbPath()` from ./worker-env; they
// must never read process.env.ALLOS_DB_PATH (that is the app server's environment,
// not the spec process's). See docs/internals/e2e-hygiene.md.

export type WorkerApp = {
  /** This worker PROCESS's index — what its directory is named for. */
  index: number;
  /** This worker's SLOT (0..workers-1) — what its port is derived from. */
  slot: number;
  /** This worker's app server origin, e.g. http://localhost:3100. */
  baseURL: string;
  port: number;
  /** This worker's SQLite file (same value as workerDbPath()). */
  dbPath: string;
  /** This worker's private directory — also the server's CWD. */
  dir: string;
  /** True for the demo project's worker (ALLOS_DEMO_MODE=1, no auto-login). */
  demo: boolean;
};

type WorkerFixtures = {
  workerApp: WorkerApp;
};

const BOOT_TIMEOUT_MS = 120_000;

function readFrozenNow(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(RUN_CONTEXT_PATH, "utf8")) as {
      frozenNow?: string;
    };
    if (raw.frozenNow) return raw.frozenNow;
  } catch {
    // fall through
  }
  // A spec invoked without global-setup (never in practice) still gets a
  // consistent clock — the app just isn't pinned to the template's instant.
  return process.env.ALLOS_TEST_NOW ?? new Date().toISOString();
}

async function waitForServer(
  url: string,
  server: ChildProcess,
  logPath: string
): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `worker server exited (${server.exitCode}) before it was ready\n` +
          tailLog(logPath)
      );
    }
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `worker server at ${url} was not ready within ${BOOT_TIMEOUT_MS}ms ` +
      `(${String(lastErr)})\n${tailLog(logPath)}`
  );
}

function tailLog(logPath: string, lines = 40): string {
  try {
    return fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "(no server log)";
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim this worker slot from a PREVIOUS generation of the same worker.
 *
 * Playwright stops a worker process after a failed test and starts a replacement
 * with the SAME parallelIndex — and it does not wait for the old process's fixture
 * teardown to finish (a hard-killed worker never runs teardown at all). The
 * replacement therefore routinely finds its port still held by its predecessor's
 * server. That is a harness artifact, never a real conflict, so the slot is
 * reclaimed rather than reported: kill the recorded pid, then wait for the port.
 * Only after that does a still-busy port mean something genuinely else is
 * listening — a stale server from an interrupted run, or another worktree using
 * the same E2E_PORT range — which is a real error worth failing on.
 */
async function reclaimPort(
  port: number,
  pidFile: string,
  budgetMs = 20_000
): Promise<void> {
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      const hardDeadline = Date.now() + 5_000;
      while (isAlive(pid) && Date.now() < hardDeadline)
        await new Promise((r) => setTimeout(r, 100));
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `port ${port} is still in use after ${budgetMs}ms — a server from an ` +
      `interrupted run, or another checkout sharing this E2E_PORT range, is ` +
      `holding it.`
  );
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const hardKill = setTimeout(() => server.kill("SIGKILL"), 5_000);
    server.once("exit", () => {
      clearTimeout(hardKill);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  // THE BROWSER RUNS ON THE APP'S FROZEN CLOCK (#1538 follow-up).
  //
  // `ALLOS_TEST_NOW` freezes the SERVER's `now()` for the whole run, but a browser
  // cannot see an env var: client code (`new Date()` — the activity form's "now"
  // prefill, relative-time widgets) kept reading real time, so the two clocks
  // drifted apart by however long the run had been going. A spec that back-dates
  // from a client-prefilled time by 40 minutes and gives it a 30-minute duration
  // has a 10-minute margin — fine when a shard ran 8 minutes, deterministically
  // broken 29 minutes into a 90-minute repeat-each lane, where the session it
  // writes lands in the SERVER's future and drops out of the finished-session
  // window (#1441). Setting each context's system time to the same frozen instant
  // closes the gap: both sides now answer the same "now", and the clock still
  // TICKS from there (setSystemTime, not setFixedTime — timers, animations and
  // polling behave normally, and elapsed time within one test stays real).
  //
  // Patching `browser.newContext` rather than overriding the `context` fixture is
  // deliberate: half the suite builds its own contexts (loginAs, cookie-less
  // anonymous contexts, phone-viewport contexts), and the built-in
  // `context`/`page` fixtures go through this same method — so one patch covers
  // every context a spec can get.
  browser: async ({ browser }, use) => {
    const at = frozenNow();
    const original = browser.newContext.bind(browser);
    const patched = async (
      ...args: Parameters<Browser["newContext"]>
    ): Promise<BrowserContext> => {
      const context = await original(...args);
      await context.clock.setSystemTime(at);
      return context;
    };
    (browser as { newContext: Browser["newContext"] }).newContext = patched;
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(browser);
    (browser as { newContext: Browser["newContext"] }).newContext = original;
  },

  workerApp: [
    async ({ browser }, use, workerInfo) => {
      // The DIRECTORY is keyed on the worker PROCESS (workerIndex, unique for the
      // run) and the PORT on the SLOT (parallelIndex, 0..workers-1): a replacement
      // worker gets a fresh directory of its own — never wiping one its retiring
      // predecessor is still serving from — and inherits only the port, which it
      // reclaims explicitly below. See e2e/worker-env.ts.
      const idx = workerInfo.workerIndex;
      const slot = workerInfo.parallelIndex;
      const demo = workerInfo.project.name === "demo";
      const dir = workerDir(idx);
      const dbPath = workerDbPath(idx);
      const port = workerPort(slot);
      const baseURL = workerBaseURL(slot);
      const logPath = path.join(dir, "server.log");
      const pidFile = slotPidPath(slot);
      const started = Date.now();

      // 1) Take the port back from the worker that previously held this slot.
      await reclaimPort(port, pidFile);

      // 2) This worker's world: a fresh COPY of the seeded template (DB + the
      //    cwd-relative data/ artifacts the seed wrote alongside it).
      fs.rmSync(dir, { recursive: true, force: true });
      fs.cpSync(demo ? TEMPLATE_DEMO_DIR : TEMPLATE_DIR, dir, {
        recursive: true,
      });
      fs.mkdirSync(path.join(dir, "data", "logs"), { recursive: true });
      fs.mkdirSync(path.join(dir, "data", "uploads"), { recursive: true });

      // 3) This worker's server: `next start` off the ONE shared production build,
      //    but with the worker dir as CWD so every cwd-relative artifact the app
      //    writes (data/uploads, data/logs/ai.jsonl, data/logs/errors.jsonl) is
      //    private to this worker.
      const logFd = fs.openSync(logPath, "a");
      const server = spawn(
        path.join(process.cwd(), "node_modules", ".bin", "next"),
        ["start", process.cwd(), "-p", String(port)],
        {
          cwd: dir,
          env: {
            ...process.env,
            ALLOS_DB_PATH: dbPath,
            ADMIN_USERNAME,
            ADMIN_PASSWORD,
            NODE_ENV: "production",
            // Frozen app clock (#990/#1464): the seed that produced the template
            // and this server must read the same instant.
            ALLOS_TEST_NOW: readFrozenNow(),
            // Outbound email capture for the email-auth spec — per worker.
            EMAIL_TEST_CAPTURE: workerMailboxPath(idx),
            ...(demo ? { ALLOS_DEMO_MODE: "1" } : {}),
          },
          stdio: ["ignore", logFd, logFd],
        }
      );
      fs.closeSync(logFd);
      // Record the pid so the NEXT generation of this worker can reclaim the port
      // even if this process is hard-killed before its teardown runs.
      const ownPid = server.pid;
      if (ownPid) fs.writeFileSync(pidFile, String(ownPid));
      const bootStart = Date.now();
      try {
        await waitForServer(`${baseURL}/login`, server, logPath);
      } catch (err) {
        await stopServer(server);
        throw err;
      }
      const bootMs = Date.now() - bootStart;

      // 4) This worker's session. A session is a row in THIS database, so the
      //    worker signs in against its own server and saves its own storageState
      //    (the replacement for the old single auth.setup.ts project).
      let authMs = 0;
      if (!demo) {
        const authStart = Date.now();
        // Both options are passed EXPLICITLY: Playwright fills any option a manual
        // newContext() omits from the test's resolved `use` — and `storageState`
        // resolves through this very fixture, so naming it here (as undefined =
        // anonymous, which is what a login context needs) keeps worker setup from
        // depending on a value it is in the middle of producing.
        const ctx = await browser.newContext({
          baseURL,
          storageState: undefined,
        });
        try {
          const page = await ctx.newPage();
          await page.goto("/login");
          await page.fill('input[name="username"]', ADMIN_USERNAME);
          await page.fill('input[name="password"]', ADMIN_PASSWORD);
          await page.click('button[type="submit"]');
          await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
            timeout: 30_000,
          });
          await ctx.storageState({ path: workerAuthPath(idx) });
        } finally {
          await ctx.close();
        }
        authMs = Date.now() - authStart;
      }

      // Belt and braces for any code path that still consults the env var: inside
      // a worker PROCESS this write is private to that worker.
      process.env.ALLOS_DB_PATH = dbPath;

      console.log(
        `[e2e] worker ${idx} (slot ${slot}${demo ? ", demo" : ""}): ${baseURL} db=${path.relative(process.cwd(), dbPath)} ` +
          `boot=${bootMs}ms auth=${authMs}ms total=${Date.now() - started}ms`
      );

      await use({ index: idx, slot, baseURL, port, dbPath, dir, demo });

      // Teardown: stop the server and drop its pid record — but only if the slot
      // still points at OUR server. A retiring worker's teardown can land after
      // its replacement has already claimed the slot, and deleting the record then
      // would strand the replacement's pid. The worker dir (DB + server.log) is
      // left on disk for postmortem; global-setup wipes e2e/.data per run.
      await stopServer(server);
      try {
        if (fs.readFileSync(pidFile, "utf8").trim() === String(ownPid))
          fs.rmSync(pidFile, { force: true });
      } catch {
        // no record to clean up
      }
    },
    // A generous setup timeout (the default is 30 s): copying the template,
    // booting the server and signing in is a few seconds on an idle machine but
    // can be much slower on a loaded one, and a fixture that times out fails EVERY
    // test the worker would have run.
    { scope: "worker", auto: true, timeout: 180_000 },
  ],

  // Point the built-in page/context — and any manual browser.newContext(), which
  // inherits these options — at THIS worker's server. (`use` is Playwright's
  // fixture-setup callback, not a React hook; the lint rule only sees the name.)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  baseURL: async ({ workerApp }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerApp.baseURL);
  },

  // Start authenticated against THIS worker's database. The demo project drives
  // its own login, so it stays anonymous.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  storageState: async ({ workerApp }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerApp.demo ? undefined : workerAuthPath(workerApp.index));
  },
});

export { expect };
