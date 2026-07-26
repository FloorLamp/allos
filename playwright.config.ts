import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import { resolveFreezeInstant } from "./lib/e2e-freeze-instant";

// Browser end-to-end tier (issue: always browser-test UI features). Separate
// from the pure unit suite (`npm test`, lib/** only) and the DB tier
// (`npm run test:db`): this boots the real Next app against an isolated, seeded
// SQLite DB and drives it in Chromium. Run with `npm run test:e2e`.

// In managed dev environments Chromium is pre-installed and PLAYWRIGHT_BROWSERS_PATH
// points at it (e.g. /opt/pw-browsers); use that binary directly so we don't
// re-download. In CI we run `npx playwright install chromium`, so this returns
// undefined and Playwright falls back to its own managed browser.
function preinstalledChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined;
  const dir = fs
    .readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .at(-1);
  if (!dir) return undefined;
  const exe = `${base}/${dir}/chrome-linux/chrome`;
  return fs.existsSync(exe) ? exe : undefined;
}

// Per-worker server ports: worker N listens on PORT_BASE + N (see
// e2e/worker-env.ts, the ONE place that maps a worker index to its port, DB and
// working directory). E2E_PORT moves the whole range at once — a sandbox with a
// narrow allowed port range sets it.
const PORT_BASE = Number(process.env.E2E_PORT ?? 3100);
const executablePath = preinstalledChromium();

// Freeze the app clock for the whole run (issue #990). The template seed and every
// worker server boot under this instant, so `lib/clock.ts`'s `now()` — and every
// date it derives (today(), workout presence, ongoing ranges, relative-time
// labels) — reads the SAME instant in the fixtures and in the app. A run can then
// never cross local midnight out from under its "today"-seeded fixtures, and the
// early-morning now-minus-hours window can't flip a relative-time assertion.
// Computed ONCE here, at config load in the RUNNER process, then handed to the
// workers on disk by e2e/global-setup.ts (workers are separate processes, so a
// module-level `new Date()` would give each of them a different instant). An
// externally-supplied ALLOS_TEST_NOW wins — used to stress a boundary hour (e.g.
// 00:10 local) on demand without waiting for real midnight.
//
// The frozen instant is the run's REAL start (issue #1048), NOT a fixed mid-day.
// Fixing it at 12:00 opened the "morning-UTC band": rows the suite writes at
// runtime keep real wall-time (SQL `datetime('now')` defaults), so from
// ~00:00–11:00 local — when real time lags a frozen noon by hours — every
// liveness/recency window (workout presence, temp red-flag, "ongoing" ranges,
// redose labels) read a just-written row as stale and ~10 specs failed
// deterministically. Freezing at real start keeps |real − frozen| ≤ the suite's own
// duration, which every window (≥45 min) tolerates, in EVERY hour. Date-boundary
// determinism is preserved: `today()` derives from this same instant, so a run only
// risks a real-midnight CROSS when it starts within its own duration of midnight,
// where SQL-stamped rows roll a day ahead of the frozen date.
//
// That residual is no longer left to chance (issue #1464). `resolveFreezeInstant`
// nudges the instant FORWARD across the boundary when the run would start inside
// the hazard window, so the frozen date sits on the side the run actually spends
// its time on — see lib/e2e-freeze-instant.ts for why forward (and not back) is the
// only direction that narrows the gap. Outside that window the instant is the real
// start, unchanged. An externally-supplied ALLOS_TEST_NOW is honored verbatim: it is
// the deliberate boundary-stress hook, so it must never be second-guessed.
const FROZEN_NOW =
  process.env.ALLOS_TEST_NOW ?? resolveFreezeInstant(new Date()).toISOString();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Seed the per-worker TEMPLATE database (and make sure the production build the
  // worker servers run is current) exactly once per run. There is deliberately NO
  // `webServer` block any more: each worker boots its OWN server against its OWN
  // copy of the template — see e2e/fixtures.ts (issue #1538).
  globalSetup: "./e2e/global-setup.ts",
  // The run's frozen instant, handed to global-setup (same process) which persists
  // it for the worker processes.
  metadata: { frozenNow: FROZEN_NOW },
  // Zero retries EVERYWHERE (#1159 closed the last flake, family-calendar). The
  // suite runs clean at --retries=0 end-to-end — the changed-spec lane, the
  // shared-infra fallback, and the sharded full matrix — so retries stay OFF: a
  // flake fails the run loudly instead of being silently retried into green
  // (`retries: 1` proves "passes within N attempts", not "works" — a ≤50%-flaky
  // spec could ship green). The on-demand e2e-full.yml census can still opt INTO
  // --retries=1 to MEASURE pass-on-retry flakes; that dispatch is the only place a
  // "flaky" status can appear now.
  retries: 0,
  // Parallel workers are HONEST now (#1538): each one has its own database and its
  // own app server, so two workers can no longer see each other's writes. Locally
  // that means the Playwright default (half the cores) instead of the old
  // `--workers=1` pin; override with `--workers=N` or PW_WORKERS.
  //
  // CI stays at ONE worker per shard for now — the 4-way shard matrix already
  // spends the runner's cores, and a GitHub runner (2 cores) has no headroom for
  // several `next start` processes. The isolation makes raising it a measurement,
  // not a redesign; see docs/internals/e2e-hygiene.md.
  workers: process.env.PW_WORKERS
    ? Number(process.env.PW_WORKERS)
    : process.env.CI
      ? 1
      : undefined,
  // The "github" reporter emits one workflow annotation per failure, so a red CI
  // run names its failing tests in the check-run annotations (readable via API)
  // instead of only inside the job log. The "json" report feeds
  // scripts/e2e-flake-report.mjs: on an e2e-full.yml dispatch run at --retries=1,
  // a test that failed then passed on retry gets status "flaky" — a confirmed
  // flake detection surfaced in the job summary. (At the default --retries=0 there
  // is no "flaky" status, so the report is an accurate empty on the sharded CI
  // matrix.) The json file lives in test-results/ (wiped by Playwright at run
  // start, written at run end), NOT in playwright-report/ — the html reporter
  // cleans that folder and ordering between the two would be fragile.
  reporter: process.env.CI
    ? [
        ["list"],
        ["github"],
        ["html", { open: "never" }],
        ["json", { outputFile: "test-results/e2e-results.json" }],
      ]
    : "list",
  use: {
    // A placeholder only: the per-worker fixture OVERRIDES baseURL with this
    // worker's own server (PORT_BASE + parallelIndex). Nothing should reach the
    // base port unless the fixture failed to load.
    baseURL: `http://localhost:${PORT_BASE}`,
    trace: "on-first-retry",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    // There is no `setup` project any more: a session is a row in ONE database, so
    // a single shared storageState cannot authenticate N per-worker databases. Each
    // worker signs in against its own server and keeps its own storage state
    // (e2e/fixtures.ts).
    {
      name: "chromium",
      // Exclude the demo spec (it runs its worker's server in demo mode)
      // and the phone-viewport specs (they belong to the `mobile` project below —
      // this project's testMatch admits EVERYTHING, so without this a
      // `--project`-less invocation like the CI e2e-changed lane's
      // `npx playwright test <spec>` would also run a `*.mobile.spec.ts` at
      // 1280×900, where the mobile shell legitimately doesn't render).
      testIgnore: [/demo\.spec\.ts/, /\.mobile\.spec\.ts$/],
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    },
    // Phone-viewport project (issue #1420). Same seeded-DB webServer and same
    // auth.setup.ts storage state as `chromium` — only the viewport (iPhone-class
    // 390×844) and `hasTouch` differ, so the mobile shell (MobileNav's top bar +
    // drawer, bottom sheets, touch targets) finally has regression coverage
    // instead of being exercised only by the handful of specs that hand-set a
    // phone viewport via `test.use`.
    //
    // OPT-IN, NOT A DUPLICATE OF THE SUITE. `testMatch` admits exactly two
    // things: `smoke.spec.ts` (the broad "every primary surface renders" sweep,
    // which is worth having at both viewports) and any spec named
    // `*.mobile.spec.ts`. The naming convention was chosen over a `@mobile` tag
    // because it needs no per-test annotation, it is visible in `ls e2e/`, and
    // the CI `e2e-changed` lane's `^e2e/.*\.spec\.ts$` glob picks a changed
    // mobile spec up automatically (it runs `npx playwright test <specs>` with no
    // `--project` filter, so the spec lands in this project by its name alone).
    // A new mobile feature lands its spec as `<feature>.mobile.spec.ts`; the rest
    // of the suite stays desktop-only, so the sharded CI matrix grows by the
    // mobile spec count, not by a second full suite.
    //
    // That name-based routing takes BOTH halves: this testMatch, and `chromium`'s
    // `testIgnore` above. A `--project`-less run (the e2e-changed lane, the sharded
    // matrix) runs a spec in EVERY project whose filters admit it, and `chromium`
    // admits everything — so without the ignore a mobile spec would also run at
    // 1280×900 and fail deterministically. (`demo` needs no such guard: its
    // testMatch only admits `demo.spec.ts`, which no `*.mobile.spec.ts` name
    // contains.)
    //
    // The #868 e2e-hygiene rules apply here UNCHANGED — spec-owned fixtures,
    // settled interactions from e2e/helpers.ts, no waitForTimeout/networkidle, no
    // unmarked `.first()`, retries: 0. See docs/internals/e2e-hygiene.md.
    {
      name: "mobile",
      testMatch: /\/(smoke|[^/]+\.mobile)\.spec\.ts$/,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
    // Demo-mode specs (#181). The worker fixture recognises this project by name
    // and boots ITS server with ALLOS_DEMO_MODE=1 off a demo-seeded template,
    // unauthenticated (the spec drives the demo login itself) — so demo mode needs
    // no second long-lived server for the whole run, just the one worker that runs
    // these tests. `fullyParallel: false` keeps that file's tests inside a single
    // worker, in order, the way they ran when the suite was pinned to one worker.
    {
      name: "demo",
      testMatch: /demo\.spec\.ts/,
      fullyParallel: false,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
