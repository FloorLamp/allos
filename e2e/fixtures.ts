import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { installStreamRevealGuard } from "./helpers";
import { pinnedTimezone } from "./pinned-timezone";
import {
  attributeSharedRowGap,
  diffSharedRows,
  NO_LEFTOVERS,
  repairAddedSharedRows,
  sharedRowDriftMessage,
  sharedRowGapMessage,
  type SharedProfileLeftovers,
  type SharedRowDrift,
  type SharedRowSnapshot,
  snapshotSharedRows,
  strandedDraftMessage,
  takeStrandedDrafts,
  type TestPosition,
} from "./shared-profile-guard";
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
// WHAT EACH WORKER GETS (all under this RUN's root, which is
// e2e/.data/port-<PORT_BASE>/ — see e2e/worker-env.ts for why the port range and
// not the worktree keys it — as worker-<workerIndex>/):
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

type TestFixtures = {
  /**
   * The standing shared-fixture guard (#3173, widened by #3946 and #5037) —
   * automatic, so no
   * spec can opt out and no new spec has to remember to opt in. See
   * e2e/shared-profile-guard.ts.
   */
  noSharedProfileLeak: void;
  /**
   * The rows a spec MEANS to leave on the shared profile, declared in its own
   * source: `test.use({ sharedProfileLeftovers: { why, titles } })`. Read by the
   * guard above; there is deliberately no list of exempt spec names anywhere.
   */
  sharedProfileLeftovers: SharedProfileLeftovers;
};

// THE ONE CLOCK, CHECKED — the standing guard against #3364.
//
// The seed pins the instance-default timezone from the run's frozen instant
// (e2e/seed/prelude.ts) and the `timezoneId` fixture below pins the browser from the
// same instant. Those are two DIFFERENT reads in two different processes — the seed
// child's `ALLOS_TEST_NOW`, and this worker's read of the persisted run context —
// and `pinnedTimezone` is a pure function of the UTC HOUR, so any drift between them
// is total, off by a whole hour, and SILENT.
//
// Silent is the part that cost three lanes a diagnosis each. A worker whose browser
// zone disagrees with its own database does not fail here; it renders
// TravelTimezoneBanner on every own-profile page — the banner is CORRECT, the device
// really is somewhere the profile is not — and then a geometry assertion in an
// unrelated spec reads 130px low and gets blamed on whichever PR was running. Asking
// the question once per worker turns that into one named failure before the first
// test.
//
// TWO INDEPENDENT SOURCES on purpose: what the SEED WROTE, read back out of this
// worker's own database, against what this worker is about to pin the browser to. A
// check that derived both from one value would be a tautology, and would have been
// green through the whole of #3364.
function assertSeedAndBrowserShareOneZone(
  dbPath: string,
  pinned: string
): void {
  const db = new Database(dbPath, { fileMustExist: true });
  let seeded: string | undefined;
  try {
    db.pragma("busy_timeout = 5000");
    seeded = (
      db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as
        { value: string } | undefined
    )?.value;
  } finally {
    db.close();
  }
  if (seeded === pinned) return;
  throw new Error(
    `[e2e] this worker's browser zone and its seeded profiles disagree (#3364):\n` +
      `  seeded instance timezone: ${seeded ?? "<no row — did seedPrelude run?>"}\n` +
      `  browser timezoneId:       ${pinned}\n\n` +
      `Both derive from the run's frozen instant through pinnedTimezone(), which is ` +
      `a pure function of the UTC HOUR — so this means the two sides read DIFFERENT ` +
      `instants. The usual cause is a per-process clock read (a module-scope ` +
      `\`new Date()\`) somewhere in that chain instead of the instant global-setup ` +
      `persisted; playwright.config.ts carries the receipt.\n\n` +
      `Left alone this does not fail here: every own-profile page grows a travel ` +
      `banner above its content, and some unrelated geometry assertion fails 130px ` +
      `low instead.`
  );
}

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

// THE READING THE PREVIOUS TEST IN THIS WORKER ENDED ON (#5266).
//
// Module scope, because a Playwright worker IS a process: this holds one worker's
// last reading and nothing crosses between workers, and a worker that restarts gets
// a fresh process and a fresh (empty) one. It is what the next test's `before` is
// compared against — the escape window, at no extra query, since both readings are
// already taken for the per-test diff.
let previousReading: {
  position: TestPosition;
  after: SharedRowSnapshot;
} | null = null;

/** The rows `repairAddedSharedRows` has just deleted, dropped from a reading. */
function withoutRepaired(
  reading: SharedRowSnapshot,
  repaired: SharedRowDrift["added"]
): SharedRowSnapshot {
  const gone = new Set(repaired.map((row) => `${row.table}:${row.id}`));
  return reading.filter((row) => !gone.has(`${row.table}:${row.id}`));
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // NO SPEC MAY STRAND A LIVE DRAFT — OR A SAVED ROW — ON THE SHARED PROFILE
  // (#3173, #3946).
  //
  // Declared FIRST and `auto`, so it is set up before the test's own fixtures and
  // therefore torn down after them — the check runs once the page and its context
  // are gone and the worker's database has stopped moving. Failing from teardown is
  // what makes the guard name the test that CAUSED the leak; the alternative (a
  // global teardown) could only name the run, by which point the worker database it
  // would have to read has been thrown away.
  //
  // It depends on `workerApp` for the database this worker actually owns, never on
  // process.env.ALLOS_DB_PATH — that is the app server's environment, not this
  // process's. The demo project is exempt: it runs a different seed (scripts/seed.ts
  // with no e2e event layer) against its own template, and its one spec drives the
  // demo login rather than acting as the shared admin.
  noSharedProfileLeak: [
    // eslint-disable-next-line react-hooks/rules-of-hooks
    async ({ workerApp, sharedProfileLeftovers }, use, testInfo) => {
      // The BEFORE reading of the saved-row diff (#3946). It is taken here rather
      // than in a `beforeEach` so that a `beforeAll` fixture — which runs before
      // any test's fixtures — is already in it: a row a whole FILE owns and tears
      // down in `afterAll` is in both readings, so no TEST is blamed for it. The
      // gap below is where such a row IS visible, charged to the hook that wrote
      // it and to no test at all (#5266).
      const at = frozenNow();
      const before = workerApp.demo
        ? []
        : snapshotSharedRows(at, workerApp.dbPath);
      // The enclosing `test.describe` titles. Measured on this suite, `titlePath`
      // reads [file, …describes, title] — but taking everything after the LAST
      // entry that names this file assumes nothing about what precedes it, and a
      // shape that surprises us degrades to the file-only rule (describes: []),
      // never to a wrong name.
      const file = path.basename(testInfo.file);
      const enclosing = testInfo.titlePath.slice(0, -1);
      const position: TestPosition = {
        file,
        describes: enclosing.slice(
          enclosing.findLastIndex((entry) => entry.endsWith(file)) + 1
        ),
        title: testInfo.title,
      };
      // THE GAP: this reading against the one the previous test ended on (#5266).
      // Everything that moved in between escaped BOTH per-test windows, so this is
      // the only place it is ever visible — and it is charged to whoever owned the
      // window, which across a suite boundary is that suite's `beforeAll` and
      // never the previous test.
      if (!workerApp.demo && previousReading) {
        const gap = diffSharedRows(previousReading.after, before);
        if (gap.added.length + gap.missing.length > 0) {
          const culprit = attributeSharedRowGap(
            previousReading.position,
            position
          );
          // A row that escaped the PREVIOUS TEST belongs to nobody, so it is taken
          // out — otherwise it sits in every later reading on this worker and is
          // invisible from here on, which is the whole defect. A row a new file's
          // `beforeAll` just wrote is that FILE's for the length of its run, and
          // deleting it would fail every test in the file instead of this one; it
          // is reported and left, and the next test's gap is silent because both
          // readings then hold it.
          if (culprit.kind === "previous-test")
            repairAddedSharedRows(gap, workerApp.dbPath);
          previousReading = {
            position,
            after:
              culprit.kind === "previous-test"
                ? withoutRepaired(before, gap.added)
                : before,
          };
          throw new Error(sharedRowGapMessage(culprit, gap, at));
        }
      }
      // eslint-disable-next-line react-hooks/rules-of-hooks
      await use();
      if (workerApp.demo) return;
      const stranded = takeStrandedDrafts(workerApp.dbPath);
      const after = snapshotSharedRows(at, workerApp.dbPath);
      // Recorded BEFORE any throw below, and after every repair above it, so the
      // next test's gap is measured against the profile as this guard leaves it —
      // a row IT removed must not read as the next test's leak.
      previousReading = { position, after };
      if (stranded.length > 0) throw new Error(strandedDraftMessage(stranded));
      if (
        sharedProfileLeftovers.rows.length > 0 &&
        !sharedProfileLeftovers.why.trim()
      )
        throw new Error(
          `sharedProfileLeftovers declares ${sharedProfileLeftovers.rows.length} ` +
            `row(s) with no \`why\` — say what makes these rows worth leaving on ` +
            `the shared profile (#3946).`
        );
      const drift = diffSharedRows(before, after, sharedProfileLeftovers);
      if (
        drift.added.length +
          drift.missing.length +
          drift.staleDeclarations.length ===
        0
      )
        return;
      repairAddedSharedRows(drift, workerApp.dbPath);
      previousReading = {
        position,
        after: withoutRepaired(after, drift.added),
      };
      throw new Error(sharedRowDriftMessage(drift, at));
    },
    { auto: true },
  ],

  // eslint-disable-next-line react-hooks/rules-of-hooks
  sharedProfileLeftovers: [NO_LEFTOVERS, { option: true }],

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
      // Every page from every context gets the streamed-reveal guard (#1644):
      // full-document navigations wait out React's Suspense staging window, so
      // no spec can catch a census testid in its two-copies-in-the-DOM state.
      // Same rationale as the clock patch above for living HERE: half the suite
      // builds its own contexts, and this hook covers them all.
      context.on("page", installStreamRevealGuard);
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
            // Opt in the authenticated, test-only UI fixtures. Their routes
            // return 404 from every ordinary deployment.
            ALLOS_E2E_TEST_HARNESS: "1",
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

      // 4) This worker's session — ALREADY HERE, copied in with the template.
      //
      //    A session is still a row in THIS database; it is just minted at seed
      //    time rather than by driving the login form once per worker. The seed
      //    (e2e/seed/session.ts) writes the storageState next to the DB it
      //    matches, so step 2's copy lands it at exactly workerAuthPath(idx) and
      //    there is nothing to do here but check the copy arrived.
      //
      //    That check is deliberately fatal rather than a silent fall back to
      //    signing in. A fallback would still go green — just two seconds slower
      //    per worker, which is the whole cost this removed — so a seed that quietly
      //    stopped writing the file would be invisible for exactly as long as
      //    nobody re-read a timing log.
      //
      //    The demo template runs scripts/seed.ts WITHOUT the e2e event layer, so
      //    it has no seeded session and demo specs sign themselves in — same as
      //    before.
      if (!demo && !fs.existsSync(workerAuthPath(idx))) {
        throw new Error(
          `worker ${idx}: no seeded session at ${workerAuthPath(idx)} — ` +
            `e2e/seed/session.ts must write it into the template (see #1538)`
        );
      }

      // Belt and braces for any code path that still consults the env var: inside
      // a worker PROCESS this write is private to that worker.
      process.env.ALLOS_DB_PATH = dbPath;

      console.log(
        `[e2e] worker ${idx} (slot ${slot}${demo ? ", demo" : ""}): ${baseURL} db=${path.relative(process.cwd(), dbPath)} ` +
          `boot=${bootMs}ms total=${Date.now() - started}ms`
      );

      // One question, once per worker, before its first test (see the guard above).
      // The demo template is seeded by scripts/seed.ts alone and stays UTC on
      // purpose — its specs are time-neutral — so it has no pin to agree with.
      //
      // DO NOT "STRENGTHEN" THIS INTO `assert seeded === "UTC"`. It sounds stricter
      // and is weaker: it would hard-code a SECOND source of truth for a zone
      // scripts/seed.ts already decides, so the day the demo seed's zone changes,
      // this fails for a reason that has nothing to do with the clock agreement it
      // is here to check. A skip that names its reason is honest; an assertion that
      // duplicates somebody else's decision is a second producer of it.
      if (!demo) assertSeedAndBrowserShareOneZone(dbPath, pinnedZone());

      await use({ index: idx, slot, baseURL, port, dbPath, dir, demo });

      // Teardown: stop the server and drop its pid record — but only if the slot
      // still points at OUR server. A retiring worker's teardown can land after
      // its replacement has already claimed the slot, and deleting the record then
      // would strand the replacement's pid. The worker dir (DB + server.log) is
      // left on disk for postmortem; global-setup wipes THIS RUN'S ROOT per run,
      // and a concurrent run on another port range has a root of its own (#3921).
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

  // THE DEVICE ZONE, FROM THE RUN'S PERSISTED INSTANT — not from this process's
  // clock (#3364).
  //
  // The browser is pinned to the profiles' zone so the travel banner stays silent
  // for the right reason (#3263 — playwright.config.ts says why at length). The
  // pin has to be derived from the SAME instant the seed used, and this is the only
  // place that can be true: `playwright.config.ts` is loaded by every worker
  // PROCESS, so its module-scope `new Date()` is a fresh instant in each of them,
  // while the seed pinned the instance timezone from the runner's instant. Both
  // sides feed `pinnedTimezone`, which is a pure function of the UTC HOUR — so a
  // worker that booted after the run crossed :00 pinned its browser one hour away
  // from every profile in its own database.
  //
  // What that cost, before this line existed: `deviceZone !== profileZone` is
  // exactly TravelTimezoneBanner's condition, so every own-profile page in that
  // worker rendered a 130px banner above the page content, and every geometry
  // assertion below it read 130px low — in specs that had nothing to do with
  // timezones and whose diffs rendered nothing on the route. Three lanes diagnosed
  // it as a co-residency leak (#3364) because it looked exactly like one: stable
  // value, random occurrence, immune to re-runs.
  //
  // `readFrozenNow()` is the persisted instant global-setup wrote — the same read
  // the worker server's own `ALLOS_TEST_NOW` uses above, so the browser, the app
  // and the seed now answer one clock.
  //
  // A spec that WANTS the two to disagree still says so per context
  // (`browser.newContext({ timezoneId })`), which is untouched by this.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  timezoneId: async ({}, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(pinnedZone());
  },
});

/** The zone the whole run is pinned to, from the instant global-setup persisted. */
function pinnedZone(): string {
  return pinnedTimezone(readFrozenNow()).zone;
}

export { expect };
