import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { specsNeedingIsolation } from "./vitest.isolation";

// DB integration tests (a SEPARATE tier from the pure unit suite in
// lib/__tests__). These open real better-sqlite3 handles to exercise code that
// needs a live schema: the migration/upgrade path in lib/db.ts (fresh-boot vs.
// existing-DB "upgrade" divergence a fresh-only suite can't see), and the query
// layer executed against a seeded fixture (catching SQL typos / broken joins /
// scoping leaks the source-scan can't). Run via `npm run test:db`; gated in CI.
// The `@/*` alias mirrors tsconfig.json `paths`, same as vitest.config.ts.
const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "@": root };

// Routed by scanning, never by hand — see vitest.isolation.ts for what disqualifies
// a spec from the shared registry and why that is a scan rather than a list.
const ISOLATED = specsNeedingIsolation(root, [
  "lib/__db_tests__",
  "lib/__action_tests__",
]);

// Both projects load the same setup pair the tier has always used: the db setup
// points the singleton at a throwaway database, and the action setup adds the auth
// / next-cache mocks the server-action tests need (harmless for the query tests,
// which import neither module). The shared project swaps the first for the variant
// that reseeds and rebinds per file.
const ACTION_SETUP = "lib/__action_tests__/setup.ts";

// PER-TEST CEILING FOR THIS TIER — a HANG detector, not a performance budget.
//
// Vitest's implicit default is 5 000 ms, sized for a unit test that touches no
// disk. This tier's fixtures BUILD DATABASES: the shared project reseeds a
// pre-migrated template per file, and a few specs replay the whole migration
// chain inside a single `it()`. Measured 2026-08-21 on a 4-core box, the tier
// running ALONE (load average 0.78 rising to 6.03, its own four workers):
//
//   761 files / 6489 tests / 161 s wall
//   per-test p50 4 ms · p95 111 ms · p99 768 ms · p99.9 1 155 ms
//   worst single test 3 407 ms — lib/__action_tests__/video.actions.test.ts
//
// So the 5 000 ms default gave the tier's WORST test 1.47x of headroom on an
// idle machine. That is not a ceiling anyone chose; it is the one vitest ships,
// and the tier had grown under it until a single slow fixture would have tipped
// it. The number below is chosen against the measurement instead:
//
//   15 000 ms = 4.4x the measured worst test (3 407 ms)
//             = 13x the measured p99.9 (1 155 ms)
//
// It still FAILS a regression that makes the slowest test 4.4x slower, or any
// ordinary test ~13x slower, which is the size of regression a per-test ceiling
// can honestly detect. Gradual tier-wide slowdown is not this constant's job —
// CI's whole-tier wall time is, and it is stable enough to read: sampling 100
// `test-db` jobs from 18–21 Aug 2026 gave median 153 s, p95 167 s, max 181 s
// (max/median 1.18x), on 99 distinct ephemeral runners for 100 jobs. CI does
// not co-schedule this job with anything, so a tight ceiling there is a real
// tripwire rather than a flake generator — that is what makes 15 000 ms safe to
// keep strict in CI while the orchestration box overrides it below.
//
// RE-DERIVE, do not nudge: run the tier alone with
// `--testTimeout=120000 --reporter=json` and read the slowest test back out.
// If the worst test has crept past ~5 000 ms, the right answer is to fix that
// test (the migration chain grows with every merge — see #3436), not to raise
// this number again.
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

// ORCHESTRATION-BOX ESCAPE HATCH, in milliseconds. Up to five agents share four
// cores on the dispatch box, and the same tier measured there at load average
// 18.1 took 862 s instead of 161 s — 5.35x wall, 5.7x at the per-test p99, worst
// single test 16 308 ms. Under the 5 000 ms default that is 59 tests over the
// ceiling and none of them wrong, which is the failure shape #3436 records four
// lanes paying a re-run cycle to diagnose.
//
// `scripts/orchestration/agent-gates.sh` sets this to 60 000 ms. Nothing in CI
// sets it, so CI keeps DEFAULT_TEST_TIMEOUT_MS.
const testTimeout = Number(
  process.env.ALLOS_DB_TEST_TIMEOUT_MS ?? DEFAULT_TEST_TIMEOUT_MS
);

// Vitest ships hookTimeout at 2x testTimeout, and that ratio is load-bearing
// here: 433 of the tier's files do their setup in a `beforeAll`/`beforeEach`,
// so a hook ceiling left at its 10 000 ms default while the test ceiling moves
// would simply become the new binding constraint — and it fails with a
// different sentence ("Hook timed out in 10000ms") that no runbook describes.
// Keep them proportional.
const hookTimeout = testTimeout * 2;

export default defineConfig({
  resolve: { alias },
  test: {
    // TWO PROJECTS, ONE RUN — so `test:db:coverage` still measures the WHOLE tier
    // in a single pass and the floors below need no cross-report merging.
    //
    // Importing lib/db.ts boots a database and pulls every migration module as a
    // module side effect, and `isolate: true` pays that once per test file. The
    // mock-free specs — the large majority of BOTH directories — instead share one
    // module registry per worker, with per-file isolation preserved by reseeding
    // from a pre-migrated template and rebinding the singleton. Only what a shared
    // registry genuinely cannot host stays isolated: the handful of specs that call
    // vi.mock() themselves, and the one that calls process.chdir().
    projects: [
      {
        resolve: { alias },
        test: {
          name: "db-shared",
          testTimeout,
          hookTimeout,
          include: [
            "lib/__db_tests__/**/*.test.ts",
            "lib/__action_tests__/**/*.test.ts",
          ],
          exclude: ISOLATED,
          pool: "threads",
          isolate: false,
          globalSetup: ["lib/__db_tests__/global-setup.ts"],
          setupFiles: ["lib/__db_tests__/setup-shared.ts", ACTION_SETUP],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "db-isolated",
          testTimeout,
          hookTimeout,
          include: ISOLATED,
          setupFiles: ["lib/__db_tests__/setup.ts", ACTION_SETUP],
        },
      },
    ],
    // Coverage for the DB+action tier — a SECOND gate alongside the pure suite's
    // (vitest.config.ts). The pure gate never imports the query/action write paths
    // that need a live schema, so those modules report ~0% there; this tier
    // exercises them and measures its own floor. Same `lib/**` denominator and
    // exclude discipline as the pure gate — one convention, two tiers — so a
    // per-file view could be merged later (see test:db:coverage). Run via
    // `npm run test:db:coverage`; wired into CI's check job.
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      exclude: [
        // Test tiers — not production code.
        "lib/__tests__/**",
        "lib/__db_tests__/**",
        "lib/__action_tests__/**",
        // Generated / pure-data modules (no logic to exercise) — same list the
        // pure gate excludes so the denominators line up.
        "lib/canonical-result-definitions.json", // generated (scripts/gen-canonical-result-definitions.ts); not TS
        "lib/growth-charts.json", // generated (scripts/gen-growth-charts.ts); pure data
        "lib/supplement-catalog.ts", // hand-maintained pure data, no functions
      ],
      reporter: ["text", "text-summary"],
      // CI REGRESSION FLOOR for the DB+action tier — a tripwire, not a stretch
      // goal, same discipline as the pure gate. These sit ~5 points BELOW the
      // measured whole-tier lib/** coverage so routine additions don't trip the
      // gate but a real drop does. The run FAILS when coverage falls below any
      // floor. Re-measure with `npm run test:db:coverage` and bump the floors up
      // (never down toward 0) if the covered baseline rises meaningfully.
      //
      // This tier reaches the query/action write paths the pure gate can't, so
      // its lines/statements/functions land HIGHER than a naive read of the pure
      // floors would suggest; branches are lower because the many defensive/error
      // arms in the query layer stay unexercised by the happy-path fixtures.
      thresholds: {
        lines: 51, // measured 56.61%
        statements: 48, // measured 53.04%
        branches: 34, // measured 39.97%
        functions: 51, // measured 56.47%
      },
    },
  },
});
